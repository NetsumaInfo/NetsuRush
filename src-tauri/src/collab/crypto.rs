//! Project keys and the sealed envelope (`docs/collab.md` §5.3, §6.1).
//!
//! Everything Convex ever receives about a project's content is sealed here first. The server keeps
//! ciphertext, sizes and routing metadata; it can order and authorise, never read.
//!
//! No cipher, key conversion or signature scheme is invented: HPKE with DHKEM(X25519,
//! HKDF-SHA256) wraps the project key for each authorised device, HKDF-SHA256 derives one subkey per
//! purpose, and XChaCha20-Poly1305 seals each payload under a fresh random 192-bit nonce.
//!
//! The header travels in CLEAR but authenticated: a device must know which `keyEpoch` to try before
//! it can decrypt anything, so putting the epoch inside the ciphertext would be a deadlock. It is
//! signed together with the ciphertext, while the stable protocol/project/purpose domain is also
//! AEAD associated data. The full header cannot be AEAD input because it contains the resulting
//! ciphertext hash; the signature authenticates that complete, non-circular envelope.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use hpke::aead::ChaCha20Poly1305 as HpkeAead;
use hpke::kdf::HkdfSha256 as HpkeKdf;
use hpke::kem::X25519HkdfSha256 as HpkeKem;
use hpke::{Deserializable, OpModeR, OpModeS, Serializable};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::Zeroizing;

use super::identity;
use super::ids::ProjectId;

const RING_VERSION: u32 = 1;
const NONCE_LEN: usize = 24;
const KEY_LEN: usize = 32;

/// HPKE `info`, and the HKDF labels. Versioned so a future scheme cannot be confused with this one,
/// and distinct per purpose so a checkpoint key can never decrypt a head.
const HPKE_DOMAIN: &[u8] = b"NetsuRush/project-key/v1\0";
const LABEL_CHECKPOINT: &[u8] = b"NetsuRush/v1/checkpoint";
const LABEL_HEAD: &[u8] = b"NetsuRush/v1/head";
const LABEL_THUMBNAIL: &[u8] = b"NetsuRush/v1/thumbnail";
const LABEL_DIRECT_UPDATE: &[u8] = b"NetsuRush/v1/direct-update";

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Purpose {
    Checkpoint,
    Head,
    Thumbnail,
    DirectUpdate,
}

impl Purpose {
    fn label(self) -> &'static [u8] {
        match self {
            Self::Checkpoint => LABEL_CHECKPOINT,
            Self::Head => LABEL_HEAD,
            Self::Thumbnail => LABEL_THUMBNAIL,
            Self::DirectUpdate => LABEL_DIRECT_UPDATE,
        }
    }
}

#[derive(Debug)]
pub enum CryptoError {
    Io(String),
    /// Authentication failed, the ring is damaged, or the payload was truncated. Never distinguished
    /// further: telling an attacker which part failed is free information.
    Sealed(String),
    UnknownEpoch(u32),
    Identity(String),
}

impl std::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(what) => write!(f, "project keys: {what}"),
            Self::Sealed(what) => write!(f, "sealed payload refused: {what}"),
            Self::UnknownEpoch(epoch) => write!(
                f,
                "this device does not hold key epoch {epoch}; ask a member of the project to enrol it again"
            ),
            Self::Identity(what) => write!(f, "device identity: {what}"),
        }
    }
}

/// Cleartext, authenticated header. `keyEpoch` MUST be readable without decrypting: a device that
/// cannot tell which key to try cannot even start.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Header {
    pub project_id: String,
    pub device_id: String,
    pub seq: u64,
    pub base_checkpoint_epoch: u64,
    pub key_epoch: u32,
    pub purpose: Purpose,
    /// BLAKE3 of the ciphertext, so a republication can be recognised as identical byte for byte.
    pub ciphertext_hash: String,
}

/// What the renderer carries to Convex: opaque bytes plus the header Convex is allowed to index.
#[derive(Debug, Serialize, Deserialize)]
pub struct SealedEnvelope {
    pub header: Header,
    pub ciphertext: String,
    pub signature: String,
}

#[derive(Serialize, Deserialize)]
struct StoredEpoch {
    epoch: u32,
    protected: String,
}

#[derive(Serialize, Deserialize)]
struct StoredRing {
    version: u32,
    current: u32,
    epochs: Vec<StoredEpoch>,
}

struct Ring {
    current: u32,
    epochs: HashMap<u32, Zeroizing<[u8; KEY_LEN]>>,
    path: PathBuf,
}

static RINGS: Mutex<Option<HashMap<String, Ring>>> = Mutex::new(None);

fn keys_dir() -> PathBuf {
    identity::collab_dir().join("keys")
}

fn ring_path(project_id: &str) -> Result<PathBuf, CryptoError> {
    let project_id =
        ProjectId::parse(project_id).map_err(|error| CryptoError::Io(error.to_string()))?;
    Ok(keys_dir().join(format!("{}.json", project_id.storage_key())))
}

fn load_ring(project_id: &str) -> Result<Ring, CryptoError> {
    let path = ring_path(project_id)?;
    match fs::read(&path) {
        Ok(bytes) => {
            let stored: StoredRing = serde_json::from_slice(&bytes)
                .map_err(|err| CryptoError::Io(format!("malformed key ring: {err}")))?;
            if stored.version != RING_VERSION {
                return Err(CryptoError::Io(format!(
                    "key ring format {} is not the one this build reads ({RING_VERSION})",
                    stored.version
                )));
            }
            let mut epochs = HashMap::new();
            for entry in stored.epochs {
                let blob = BASE64
                    .decode(entry.protected.as_bytes())
                    .map_err(|err| CryptoError::Io(format!("malformed key blob: {err}")))?;
                let plain = identity::unprotect_bytes(&blob)
                    .map_err(|err| CryptoError::Io(err.to_string()))?;
                if plain.len() != KEY_LEN {
                    return Err(CryptoError::Io("key of the wrong length".into()));
                }
                let mut key = Zeroizing::new([0u8; KEY_LEN]);
                key.copy_from_slice(&plain);
                epochs.insert(entry.epoch, key);
            }
            Ok(Ring {
                current: stored.current,
                epochs,
                path,
            })
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Ring {
            current: 0,
            epochs: HashMap::new(),
            path,
        }),
        Err(err) => Err(CryptoError::Io(err.to_string())),
    }
}

/// Atomic replace. A ring written half-way would cost every retired key at once — and with them the
/// ability to read heads still sitting on the server.
fn save_ring(ring: &Ring) -> Result<(), CryptoError> {
    let mut epochs = Vec::new();
    for (epoch, key) in &ring.epochs {
        let protected = identity::protect_bytes(key.as_slice())
            .map_err(|err| CryptoError::Io(err.to_string()))?;
        epochs.push(StoredEpoch {
            epoch: *epoch,
            protected: BASE64.encode(protected),
        });
    }
    epochs.sort_by_key(|entry| entry.epoch);
    let stored = StoredRing {
        version: RING_VERSION,
        current: ring.current,
        epochs,
    };
    let body = serde_json::to_vec_pretty(&stored)
        .map_err(|err| CryptoError::Io(format!("cannot encode the key ring: {err}")))?;
    super::ids::atomic_write(&ring.path, &body).map_err(|err| CryptoError::Io(err.to_string()))?;
    Ok(())
}

fn with_ring<T>(
    project_id: &str,
    body: impl FnOnce(&mut Ring) -> Result<T, CryptoError>,
) -> Result<T, CryptoError> {
    let mut guard = RINGS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    if !map.contains_key(project_id) {
        map.insert(project_id.to_string(), load_ring(project_id)?);
    }
    body(map.get_mut(project_id).expect("just inserted"))
}

/// Starts a new key epoch and makes it the one new writes use.
///
/// Retired epochs are KEPT, read-only. Destroying them the moment a new key exists would make every
/// head still published under the old one unreadable — including branches whose only surviving copy
/// is on the server.
pub fn rotate(project_id: &str) -> Result<u32, CryptoError> {
    with_ring(project_id, |ring| {
        let mut key = Zeroizing::new([0u8; KEY_LEN]);
        getrandom::fill(key.as_mut_slice())
            .map_err(|err| CryptoError::Io(format!("no OS randomness: {err}")))?;
        let epoch = ring.current + 1;
        ring.epochs.insert(epoch, key);
        ring.current = epoch;
        save_ring(ring)?;
        Ok(epoch)
    })
}

pub fn current_epoch(project_id: &str) -> Result<u32, CryptoError> {
    with_ring(project_id, |ring| Ok(ring.current))
}

/// Installs a project key received as an HPKE envelope — how a newly enrolled device gets in.
pub fn install_epoch(project_id: &str, epoch: u32, envelope: &[u8]) -> Result<(), CryptoError> {
    let identity = identity::get_or_init().map_err(|err| CryptoError::Identity(err.to_string()))?;
    let info = hpke_info(project_id, epoch, &identity.public().exchange_public)?;
    let secret =
        identity::exchange_secret_bytes().map_err(|err| CryptoError::Identity(err.to_string()))?;
    let private = <HpkeKem as hpke::Kem>::PrivateKey::from_bytes(secret.as_slice())
        .map_err(|err| CryptoError::Sealed(err.to_string()))?;
    if envelope.len() < 32 {
        return Err(CryptoError::Sealed("envelope too short".into()));
    }
    let (encapped, ciphertext) = envelope.split_at(32);
    let encapped = <HpkeKem as hpke::Kem>::EncappedKey::from_bytes(encapped)
        .map_err(|err| CryptoError::Sealed(err.to_string()))?;
    let plain = hpke::single_shot_open::<HpkeAead, HpkeKdf, HpkeKem>(
        &OpModeR::Base,
        &private,
        &encapped,
        &info,
        ciphertext,
        &[],
    )
    .map_err(|err| CryptoError::Sealed(err.to_string()))?;
    if plain.len() != KEY_LEN {
        return Err(CryptoError::Sealed(
            "project key of the wrong length".into(),
        ));
    }
    with_ring(project_id, |ring| {
        let mut key = Zeroizing::new([0u8; KEY_LEN]);
        key.copy_from_slice(&plain);
        ring.epochs.insert(epoch, key);
        ring.current = ring.current.max(epoch);
        save_ring(ring)?;
        Ok(())
    })
}

/// Wraps the current project key for one authorised device, given its published X25519 key.
///
/// Once this envelope is on the server the recipient can enrol without the sender staying online.
pub fn wrap_for_device(
    project_id: &str,
    recipient_exchange_hex: &str,
) -> Result<(u32, String), CryptoError> {
    let recipient = decode_hex32(recipient_exchange_hex)?;
    let public = <HpkeKem as hpke::Kem>::PublicKey::from_bytes(&recipient)
        .map_err(|err| CryptoError::Sealed(err.to_string()))?;
    with_ring(project_id, |ring| {
        let epoch = ring.current;
        let info = hpke_info(project_id, epoch, recipient_exchange_hex)?;
        let key = ring
            .epochs
            .get(&epoch)
            .ok_or(CryptoError::UnknownEpoch(epoch))?;
        let (encapped, ciphertext) = hpke::single_shot_seal::<HpkeAead, HpkeKdf, HpkeKem>(
            &OpModeS::Base,
            &public,
            &info,
            key.as_slice(),
            &[],
        )
        .map_err(|err| CryptoError::Sealed(err.to_string()))?;
        let mut blob = encapped.to_bytes().to_vec();
        blob.extend_from_slice(&ciphertext);
        Ok((epoch, BASE64.encode(blob)))
    })
}

fn hpke_info(
    project_id: &str,
    epoch: u32,
    recipient_exchange_hex: &str,
) -> Result<Vec<u8>, CryptoError> {
    let project =
        ProjectId::parse(project_id).map_err(|error| CryptoError::Io(error.to_string()))?;
    let recipient = decode_hex32(recipient_exchange_hex)?;
    let mut info = Vec::with_capacity(HPKE_DOMAIN.len() + project.as_str().len() + 40);
    info.extend_from_slice(HPKE_DOMAIN);
    info.extend_from_slice(&(project.as_str().len() as u32).to_le_bytes());
    info.extend_from_slice(project.as_str().as_bytes());
    info.extend_from_slice(&epoch.to_le_bytes());
    info.extend_from_slice(&recipient);
    Ok(info)
}

fn decode_hex32(hex: &str) -> Result<[u8; 32], CryptoError> {
    if hex.len() != 64 {
        return Err(CryptoError::Sealed("key of the wrong length".into()));
    }
    let mut out = [0u8; 32];
    for (index, slot) in out.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16)
            .map_err(|_| CryptoError::Sealed("malformed key".into()))?;
    }
    Ok(out)
}

/// One subkey per purpose, so a checkpoint key can never open a head.
fn subkey(master: &[u8; KEY_LEN], purpose: Purpose) -> Zeroizing<[u8; KEY_LEN]> {
    let hkdf = Hkdf::<Sha256>::new(None, master);
    let mut out = Zeroizing::new([0u8; KEY_LEN]);
    hkdf.expand(purpose.label(), out.as_mut_slice())
        .expect("32 bytes is a valid HKDF output length");
    out
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn canonical(header: &Header) -> Vec<u8> {
    // Field order is fixed here rather than left to a serialiser: the bytes are authenticated, so
    // two encoders disagreeing on order would reject each other's payloads.
    format!(
        "v1|{}|{}|{}|{}|{}|{:?}|{}",
        header.project_id,
        header.device_id,
        header.seq,
        header.base_checkpoint_epoch,
        header.key_epoch,
        header.purpose,
        header.ciphertext_hash
    )
    .into_bytes()
}

/// Seals a payload and signs the pair, ready to hand to the renderer for upload.
pub fn seal(
    project_id: &str,
    purpose: Purpose,
    seq: u64,
    base_checkpoint_epoch: u64,
    plaintext: &[u8],
) -> Result<SealedEnvelope, CryptoError> {
    let identity = identity::get_or_init().map_err(|err| CryptoError::Identity(err.to_string()))?;
    let (key_epoch, blob) = with_ring(project_id, |ring| {
        let epoch = ring.current;
        let master = ring
            .epochs
            .get(&epoch)
            .ok_or(CryptoError::UnknownEpoch(epoch))?;
        let key = subkey(master, purpose);
        let cipher = XChaCha20Poly1305::new_from_slice(key.as_slice())
            .map_err(|_| CryptoError::Sealed("bad subkey length".into()))?;
        let mut nonce = [0u8; NONCE_LEN];
        getrandom::fill(&mut nonce)
            .map_err(|err| CryptoError::Io(format!("no OS randomness: {err}")))?;
        // The header is not known yet — it carries the hash of this very ciphertext — so the AEAD is
        // bound to the project and purpose, and the signature below covers the full header.
        let aad = format!("v1|{project_id}|{purpose:?}").into_bytes();
        let ciphertext = cipher
            .encrypt(
                &XNonce::from(nonce),
                Payload {
                    msg: plaintext,
                    aad: &aad,
                },
            )
            .map_err(|_| CryptoError::Sealed("could not seal".into()))?;
        let mut blob = nonce.to_vec();
        blob.extend_from_slice(&ciphertext);
        Ok((epoch, blob))
    })?;

    let header = Header {
        project_id: project_id.to_string(),
        device_id: identity.public().device_id.clone(),
        seq,
        base_checkpoint_epoch,
        key_epoch,
        purpose,
        ciphertext_hash: hex(blake3::hash(&blob).as_bytes()),
    };
    let mut signed = canonical(&header);
    signed.extend_from_slice(&blob);
    Ok(SealedEnvelope {
        header,
        ciphertext: BASE64.encode(&blob),
        signature: BASE64.encode(identity.sign(&signed)),
    })
}

/// Opens a payload produced by `seal`, after checking the author's signature.
///
/// The key is chosen from the header's `keyEpoch`, which is why that field is readable in clear: a
/// device holding several retired keys must know which one to try.
pub fn open(
    header: &Header,
    ciphertext_b64: &str,
    signature_b64: &str,
    author_ed25519_hex: &str,
) -> Result<Vec<u8>, CryptoError> {
    let blob = BASE64
        .decode(ciphertext_b64.as_bytes())
        .map_err(|err| CryptoError::Sealed(err.to_string()))?;
    if hex(blake3::hash(&blob).as_bytes()) != header.ciphertext_hash {
        return Err(CryptoError::Sealed(
            "ciphertext does not match its header".into(),
        ));
    }
    let signature = BASE64
        .decode(signature_b64.as_bytes())
        .map_err(|err| CryptoError::Sealed(err.to_string()))?;
    let mut signed = canonical(header);
    signed.extend_from_slice(&blob);
    verify(author_ed25519_hex, &signed, &signature)?;

    if blob.len() <= NONCE_LEN {
        return Err(CryptoError::Sealed("payload truncated".into()));
    }
    let (nonce, ciphertext) = blob.split_at(NONCE_LEN);
    let nonce: [u8; NONCE_LEN] = nonce.try_into().expect("length checked just above");
    with_ring(&header.project_id, |ring| {
        let master = ring
            .epochs
            .get(&header.key_epoch)
            .ok_or(CryptoError::UnknownEpoch(header.key_epoch))?;
        let key = subkey(master, header.purpose);
        let cipher = XChaCha20Poly1305::new_from_slice(key.as_slice())
            .map_err(|_| CryptoError::Sealed("bad subkey length".into()))?;
        let aad = format!("v1|{}|{:?}", header.project_id, header.purpose).into_bytes();
        cipher
            .decrypt(
                &XNonce::from(nonce),
                Payload {
                    msg: ciphertext,
                    aad: &aad,
                },
            )
            .map_err(|_| CryptoError::Sealed("authentication failed".into()))
    })
}

fn verify(author_hex: &str, message: &[u8], signature: &[u8]) -> Result<(), CryptoError> {
    use ed25519_dalek::{Signature, Verifier as _, VerifyingKey};
    let key = decode_hex32(author_hex)?;
    let verifying =
        VerifyingKey::from_bytes(&key).map_err(|_| CryptoError::Sealed("bad author key".into()))?;
    let signature: [u8; 64] = signature
        .try_into()
        .map_err(|_| CryptoError::Sealed("bad signature length".into()))?;
    verifying
        .verify(message, &Signature::from_bytes(&signature))
        .map_err(|_| CryptoError::Sealed("signature does not verify".into()))
}

#[cfg(test)]
mod path_tests {
    use super::{canonical, hex, hpke_info, ring_path, verify, Header, Purpose};
    use ed25519_dalek::{Signer as _, SigningKey};

    #[test]
    fn key_ring_path_hashes_and_validates_project_id() {
        let path = ring_path("visible-project-name").expect("valid path");
        let file = path
            .file_name()
            .and_then(|name| name.to_str())
            .expect("UTF-8 file name");
        assert!(!file.contains("visible-project-name"));
        assert!(ring_path("../escape").is_err());
    }

    #[test]
    fn hpke_envelopes_are_bound_to_project_epoch_and_recipient() {
        let recipient = "11".repeat(32);
        let base = hpke_info("project-one", 4, &recipient).expect("info");
        assert_ne!(
            base,
            hpke_info("project-two", 4, &recipient).expect("project")
        );
        assert_ne!(
            base,
            hpke_info("project-one", 5, &recipient).expect("epoch")
        );
        assert_ne!(
            base,
            hpke_info("project-one", 4, &"22".repeat(32)).expect("recipient")
        );
    }

    #[test]
    fn envelope_signature_binds_author_project_header_and_ciphertext() {
        let signing = SigningKey::from_bytes(&[9; 32]);
        let blob = b"sealed-update";
        let header = Header {
            project_id: "project-one".into(),
            device_id: hex(&signing.verifying_key().to_bytes()),
            seq: 4,
            base_checkpoint_epoch: 2,
            key_epoch: 3,
            purpose: Purpose::DirectUpdate,
            ciphertext_hash: hex(blake3::hash(blob).as_bytes()),
        };
        let mut message = canonical(&header);
        message.extend_from_slice(blob);
        let signature = signing.sign(&message).to_bytes();
        assert!(verify(&header.device_id, &message, &signature).is_ok());

        let mut tampered = header.clone();
        tampered.project_id = "project-two".into();
        let mut tampered_message = canonical(&tampered);
        tampered_message.extend_from_slice(blob);
        assert!(verify(&header.device_id, &tampered_message, &signature).is_err());
    }
}

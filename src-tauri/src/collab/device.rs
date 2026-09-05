use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
#[cfg(test)]
use ed25519_dalek::{Signature, Verifier as _, VerifyingKey};
use ed25519_dalek::{Signer as _, SigningKey};
use serde::{Deserialize, Serialize};

use super::error::CollabError;

const REGISTRATION_DOMAIN: &[u8] = b"netsurush/device-registration/v1\0";
const REGISTRATION_VERSION: u16 = 1;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationStatement {
    pub version: u16,
    pub challenge: String,
    pub account_id: String,
    pub device_id: String,
    pub signing_public: String,
    pub exchange_public: String,
    pub endpoint_id: String,
}

impl RegistrationStatement {
    pub fn new(
        challenge: impl Into<String>,
        account_id: impl Into<String>,
        device_id: impl Into<String>,
        signing_public: impl Into<String>,
        exchange_public: impl Into<String>,
        endpoint_id: impl Into<String>,
    ) -> Result<Self, CollabError> {
        let statement = Self {
            version: REGISTRATION_VERSION,
            challenge: challenge.into(),
            account_id: account_id.into(),
            device_id: device_id.into(),
            signing_public: signing_public.into(),
            exchange_public: exchange_public.into(),
            endpoint_id: endpoint_id.into(),
        };
        statement.validate()?;
        Ok(statement)
    }

    pub fn validate(&self) -> Result<(), CollabError> {
        if self.version != REGISTRATION_VERSION {
            return Err(CollabError::validation(
                "unsupported device registration version",
            ));
        }
        validate_text("challenge", &self.challenge, 1, 256)?;
        validate_text("account id", &self.account_id, 1, 256)?;
        validate_hex_key("device id", &self.device_id)?;
        validate_hex_key("signing public key", &self.signing_public)?;
        validate_hex_key("exchange public key", &self.exchange_public)?;
        validate_hex_key("endpoint id", &self.endpoint_id)?;
        if self.device_id != self.signing_public {
            return Err(CollabError::validation(
                "device id does not match its signing public key",
            ));
        }
        if self.endpoint_id != self.signing_public {
            return Err(CollabError::validation(
                "endpoint id does not match its signing public key",
            ));
        }
        Ok(())
    }

    fn signing_bytes(&self) -> Result<Vec<u8>, CollabError> {
        self.validate()?;
        let mut bytes = Vec::with_capacity(512);
        bytes.extend_from_slice(REGISTRATION_DOMAIN);
        bytes.extend_from_slice(&self.version.to_le_bytes());
        for field in [
            self.challenge.as_bytes(),
            self.account_id.as_bytes(),
            self.device_id.as_bytes(),
            self.signing_public.as_bytes(),
            self.exchange_public.as_bytes(),
            self.endpoint_id.as_bytes(),
        ] {
            let len = u32::try_from(field.len())
                .map_err(|_| CollabError::validation("registration field is too large"))?;
            bytes.extend_from_slice(&len.to_le_bytes());
            bytes.extend_from_slice(field);
        }
        Ok(bytes)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationProof {
    pub statement: RegistrationStatement,
    pub signature: String,
}

impl RegistrationProof {
    pub fn sign(
        statement: RegistrationStatement,
        signing: &SigningKey,
    ) -> Result<Self, CollabError> {
        let bytes = statement.signing_bytes()?;
        Ok(Self {
            statement,
            signature: BASE64.encode(signing.sign(&bytes).to_bytes()),
        })
    }

    #[cfg(test)]
    pub fn verify(&self) -> Result<(), CollabError> {
        let bytes = self.statement.signing_bytes()?;
        let public = decode_hex_32(&self.statement.signing_public)?;
        let verifying = VerifyingKey::from_bytes(&public)
            .map_err(|_| CollabError::validation("invalid signing public key"))?;
        let signature = BASE64
            .decode(self.signature.as_bytes())
            .map_err(|_| CollabError::validation("invalid registration signature encoding"))?;
        let signature = Signature::from_slice(&signature)
            .map_err(|_| CollabError::validation("invalid registration signature length"))?;
        verifying
            .verify(&bytes, &signature)
            .map_err(|_| CollabError::validation("registration signature does not verify"))
    }
}

fn validate_text(
    label: &str,
    value: &str,
    minimum: usize,
    maximum: usize,
) -> Result<(), CollabError> {
    if value.len() < minimum || value.len() > maximum || value.chars().any(char::is_control) {
        return Err(CollabError::validation(format!("invalid {label}")));
    }
    Ok(())
}

fn validate_hex_key(label: &str, value: &str) -> Result<(), CollabError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return Err(CollabError::validation(format!("invalid {label}")));
    }
    Ok(())
}

#[cfg(test)]
fn decode_hex_32(value: &str) -> Result<[u8; 32], CollabError> {
    validate_hex_key("public key", value)?;
    let mut output = [0_u8; 32];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        output[index] = (hex_nibble(pair[0])? << 4) | hex_nibble(pair[1])?;
    }
    Ok(output)
}

#[cfg(test)]
fn hex_nibble(value: u8) -> Result<u8, CollabError> {
    match value {
        b'0'..=b'9' => Ok(value - b'0'),
        b'a'..=b'f' => Ok(value - b'a' + 10),
        _ => Err(CollabError::validation("invalid lowercase hexadecimal")),
    }
}

#[cfg(test)]
mod tests {
    use super::{RegistrationProof, RegistrationStatement};
    use ed25519_dalek::SigningKey;

    fn fixture() -> (SigningKey, RegistrationStatement) {
        let signing = SigningKey::from_bytes(&[7_u8; 32]);
        let signing_public = signing.verifying_key().to_bytes();
        let statement = RegistrationStatement::new(
            "challenge",
            "account",
            hex(&signing_public),
            hex(&signing_public),
            "11".repeat(32),
            hex(&signing_public),
        )
        .expect("statement");
        (signing, statement)
    }

    #[test]
    fn registration_proof_binds_every_public_identity() {
        let (signing, statement) = fixture();
        let proof = RegistrationProof::sign(statement.clone(), &signing).expect("sign proof");
        proof.verify().expect("valid proof");

        let mut changed = proof.clone();
        changed.statement.endpoint_id = "22".repeat(32);
        assert!(changed.verify().is_err());

        let mut changed = proof.clone();
        changed.statement.exchange_public = "33".repeat(32);
        assert!(changed.verify().is_err());

        let mut changed = proof;
        changed.statement.account_id = "different".into();
        assert!(changed.verify().is_err());
    }

    #[test]
    fn device_id_must_match_the_signing_public_key() {
        let (_, mut statement) = fixture();
        statement.device_id = "44".repeat(32);
        assert!(statement.validate().is_err());
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }
}

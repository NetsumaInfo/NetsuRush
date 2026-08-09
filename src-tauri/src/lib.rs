// Coquille Tauri NetsuRush : fenêtre + plugins + spawn du service Node "core".

use std::io::Write;
use std::process::{Child, Command, Stdio};
use std::path::{Path, PathBuf};
use std::sync::{atomic::{AtomicBool, Ordering}, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, RunEvent};

mod player;
mod state;

// Handle du process core, gardé en état managé → tué à la fermeture (RunEvent::Exit).
struct CoreProcess(Mutex<Option<Child>>);
static CORE_SHUTDOWN: AtomicBool = AtomicBool::new(false);

// ── Journal du service de fond ──────────────────────────────────────────────────────────────────
// En release l'app est compilée en sous-système « windows » : elle n'a PAS de console, donc la
// sortie héritée par node.exe part dans le vide. Un core qui meurt au démarrage (port occupé,
// node.exe mis en quarantaine, ressource absente) ne laissait alors AUCUNE trace : l'interface
// n'affichait qu'un « Failed to fetch » sans cause. Tout part donc dans un fichier, à côté de
// nr.config.json — même racine que NR_HOME côté core (core/config.js).
const CORE_LOG_MAX: u64 = 2 * 1024 * 1024;

// ── Port du service de fond ─────────────────────────────────────────────────────────────────────
// 8730 en dur ne tenait pas : une seconde instance de NetsuRush, une session de développement, ou
// n'importe quel logiciel tiers sur ce port, et le core mourait en EADDRINUSE — l'app restait sans
// backend, sans recours pour quelqu'un qui n'ouvre pas un terminal. La coquille choisit donc un port
// LIBRE au lancement et le renderer le lui demande (`nr_core_port`). Le choix est refait à chaque
// spawn : si le port est pris entre-temps, le redémarrage du watchdog en prend un autre tout seul.
const CORE_PORT_FIRST: u16 = 8730;
const CORE_PORT_SPAN: u16 = 20;
static CORE_PORT: std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(CORE_PORT_FIRST);

fn pick_core_port() -> u16 {
    for port in CORE_PORT_FIRST..CORE_PORT_FIRST + CORE_PORT_SPAN {
        // Le test est le seul vraiment fiable : demander l'écoute. L'écouteur est refermé aussitôt
        // (fin de portée) et Node reprend le port dans la foulée.
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return port;
        }
    }
    CORE_PORT_FIRST
}

/// Port réellement attribué au core. Le renderer bâtit son URL dessus (`coreClient`).
#[tauri::command]
fn nr_core_port() -> u16 {
    CORE_PORT.load(Ordering::Acquire)
}

fn core_log_path() -> PathBuf {
    let home = std::env::var_os("NR_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("LOCALAPPDATA").map(|dir| PathBuf::from(dir).join("NetsuRush")))
        .unwrap_or_else(std::env::temp_dir);
    home.join("logs").join("core.log")
}

fn open_core_log() -> Option<std::fs::File> {
    let path = core_log_path();
    std::fs::create_dir_all(path.parent()?).ok()?;
    // Rotation la plus simple qui tienne : au-delà du plafond on repart d'un fichier vide. Le
    // diagnostic utile est toujours la session en cours, jamais l'historique.
    if std::fs::metadata(&path).map(|meta| meta.len() > CORE_LOG_MAX).unwrap_or(false) {
        let _ = std::fs::remove_file(&path);
    }
    std::fs::OpenOptions::new().create(true).append(true).open(&path).ok()
}

fn log_core(line: &str) {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    eprintln!("[netsurush] {line}");
    if let Some(mut file) = open_core_log() {
        let _ = writeln!(file, "[netsurush {stamp}] {line}");
    }
}

fn release_lock_arg() -> Option<PathBuf> {
    let mut args = std::env::args_os().skip(1);
    while let Some(arg) = args.next() {
        if arg.as_os_str() == std::ffi::OsStr::new("--release-lock") {
            return args.next().map(PathBuf::from);
        }
    }
    None
}

// Mode court appelé UNIQUEMENT par l'installeur NSIS depuis sa copie temporaire de l'app. Restart
// Manager cherche le processus tenant exactement le binaire demandé, puis le libère. Ce n'est ni
// une énumération de processus, ni un `taskkill` global : seul node.exe de CETTE installation est
// enregistré comme ressource à fermer.
#[cfg(target_os = "windows")]
fn release_file_lock(resource: &Path) -> Result<(), String> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, ERROR_MORE_DATA, ERROR_SUCCESS};
    use windows::Win32::System::RestartManager::{
        CCH_RM_SESSION_KEY, RM_PROCESS_INFO, RmAddFilter, RmEndSession, RmForceShutdown,
        RmGetList, RmNoShutdown, RmRegisterResources, RmShutdown, RmStartSession,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    if !resource.exists() {
        return Ok(());
    }
    let mut session = 0u32;
    let mut session_key = [0u16; CCH_RM_SESSION_KEY as usize + 1];
    let started = unsafe { RmStartSession(&mut session, None, PWSTR(session_key.as_mut_ptr())) };
    if started != ERROR_SUCCESS {
        return Err(format!("Restart Manager indisponible ({})", started.0));
    }

    let resource_wide = resource
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let files = [PCWSTR(resource_wide.as_ptr())];
    let registered = unsafe { RmRegisterResources(session, Some(&files), None, None) };
    if registered != ERROR_SUCCESS {
        let _ = unsafe { RmEndSession(session) };
        return Err(format!("Ressource non enregistrée ({})", registered.0));
    }

    // Restart Manager peut aussi voir un antivirus qui inspecte le fichier. On exclut toutes les
    // entrées dont l'exécutable n'est pas exactement ce node.exe avant tout arrêt.
    let mut needed = 0u32;
    let mut count = 0u32;
    let mut reboot_reasons = 0u32;
    let listed = unsafe { RmGetList(session, &mut needed, &mut count, None, &mut reboot_reasons) };
    if listed != ERROR_SUCCESS && listed != ERROR_MORE_DATA {
        let _ = unsafe { RmEndSession(session) };
        return Err(format!("Verrou non listable ({})", listed.0));
    }
    let mut processes = vec![RM_PROCESS_INFO::default(); needed as usize];
    if needed > 0 {
        count = needed;
        let listed = unsafe {
            RmGetList(
                session,
                &mut needed,
                &mut count,
                Some(processes.as_mut_ptr()),
                &mut reboot_reasons,
            )
        };
        if listed != ERROR_SUCCESS {
            let _ = unsafe { RmEndSession(session) };
            return Err(format!("Verrou non relu ({})", listed.0));
        }
    }
    let target = resource.canonicalize().unwrap_or_else(|_| resource.to_path_buf());
    let mut target_found = false;
    for process in processes.iter().take(count as usize) {
        let same_binary = unsafe {
            OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process.Process.dwProcessId)
                .ok()
                .map(|handle| {
                    let mut image = vec![0u16; 32_768];
                    let mut length = image.len() as u32;
                    let queried = QueryFullProcessImageNameW(
                        handle,
                        PROCESS_NAME_WIN32,
                        PWSTR(image.as_mut_ptr()),
                        &mut length,
                    )
                    .is_ok();
                    let _ = CloseHandle(handle);
                    queried && PathBuf::from(std::ffi::OsString::from_wide(&image[..length as usize]))
                        .canonicalize()
                        .unwrap_or_default()
                        .as_os_str()
                        .to_string_lossy()
                        .eq_ignore_ascii_case(&target.as_os_str().to_string_lossy())
                })
                .unwrap_or(false)
        };
        if same_binary {
            target_found = true;
        } else {
            let _ = unsafe {
                RmAddFilter(
                    session,
                    PCWSTR::null(),
                    Some(&process.Process),
                    PCWSTR::null(),
                    RmNoShutdown,
                )
            };
        }
    }
    if !target_found {
        let _ = unsafe { RmEndSession(session) };
        return Ok(());
    }

    // Tente d'abord une fermeture coopérative. Un node.exe orphelin ne possède pas de fenêtre ni
    // de canal d'arrêt ; seulement dans ce cas, Restart Manager force LE verrou enregistré.
    let graceful = unsafe { RmShutdown(session, 0, None) };
    let result = if graceful == ERROR_SUCCESS {
        graceful
    } else {
        unsafe { RmShutdown(session, RmForceShutdown.0 as u32, None) }
    };
    let _ = unsafe { RmEndSession(session) };
    if result == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(format!("Le verrou n'a pas été libéré ({})", result.0))
    }
}

#[cfg(not(target_os = "windows"))]
fn release_file_lock(_resource: &Path) -> Result<(), String> {
    Err("Restart Manager est disponible uniquement sous Windows".into())
}

// La fermeture de la fenêtre doit libérer node.exe AVANT que le processus Tauri disparaisse : un
// installateur NSIS lancé juste après peut alors remplacer resources/bin/node.exe sans verrou.
fn stop_core(app: &AppHandle) {
    if let Ok(mut slot) = app.state::<CoreProcess>().0.lock() {
        if let Some(mut child) = slot.take() {
            // Arrêt coopératif : Node tue d'abord ses sidecars puis vide les frames/mattes de la
            // session. `Child::kill()` seul termine brutalement Node sous Windows et saute ce travail.
            let graceful = child
                .stdin
                .as_mut()
                .and_then(|stdin| stdin.write_all(b"shutdown\n").ok())
                .is_some();
            if graceful {
                let deadline = Instant::now() + Duration::from_secs(4);
                while Instant::now() < deadline {
                    if matches!(child.try_wait(), Ok(Some(_))) {
                        break;
                    }
                    thread::sleep(Duration::from_millis(50));
                }
            }
            if !matches!(child.try_wait(), Ok(Some(_))) {
                let _ = child.kill();
            }
            let _ = child.wait();
        }
    }
    // Filet de sécurité si Node a crashé ou dépassé le délai. Cette racine ne contient jamais de
    // sortie utilisateur, uniquement des fichiers de travail de la session.
    let _ = std::fs::remove_dir_all(std::env::temp_dir().join("netsurush-session"));
}

// Le core Node est un service séparé : un crash (DLL/sidecar, antivirus, mémoire) ne doit pas
// laisser l'interface ouverte avec des « Failed to fetch » permanents. Le watchdog réutilise le
// même Child stocké dans l'état Tauri, le relance s'il sort inopinément et l'arrête proprement à la
// fermeture de l'application.
// Un core qui meurt AUSSITÔT après son lancement ne redémarrera pas mieux au coup suivant : port
// déjà pris, node.exe absent, antivirus. Sans ce compteur, le watchdog relançait le même échec
// toutes les 750 ms sans fin — l'interface restait morte et la machine tournait pour rien.
const CORE_FAST_EXIT: Duration = Duration::from_secs(3);
const CORE_MAX_FAST_RESTARTS: u32 = 5;
// Passé ce seuil on ESPACE les tentatives au lieu d'abandonner : la cause est souvent passagère
// (analyse antivirus du binaire fraîchement installé, port libéré par l'autre programme, disque
// occupé). Abandonner laissait une application définitivement morte à quelqu'un qui n'a ni
// terminal ni moyen de relancer le service — la seule issue était de redémarrer l'application.
const CORE_WATCH_STEP: Duration = Duration::from_millis(750);
const CORE_SLOW_RETRY: Duration = Duration::from_secs(30);

fn supervise_core(app: &AppHandle) {
    let handle = app.clone();
    thread::spawn(move || {
        let mut spawned_at = Instant::now();
        let mut fast_restarts: u32 = 0;
        let mut next_try = Instant::now();
        while !CORE_SHUTDOWN.load(Ordering::Acquire) {
            thread::sleep(CORE_WATCH_STEP);
            if CORE_SHUTDOWN.load(Ordering::Acquire) {
                break;
            }
            let state = handle.state::<CoreProcess>();
            let mut slot = match state.0.lock() {
                Ok(guard) => guard,
                Err(_) => continue,
            };
            let exited = match slot.as_mut() {
                Some(child) => match child.try_wait() {
                    Ok(Some(status)) => {
                        log_core(&format!("le service de fond s'est arrêté ({status})"));
                        true
                    }
                    Err(error) => {
                        log_core(&format!("état du service de fond illisible : {error}"));
                        true
                    }
                    Ok(None) => false,
                },
                None => true,
            };
            if exited && !CORE_SHUTDOWN.load(Ordering::Acquire) {
                if Instant::now() < next_try {
                    continue; // en attente ralentie : on ne relance pas encore
                }
                if spawned_at.elapsed() < CORE_FAST_EXIT {
                    fast_restarts += 1;
                } else {
                    fast_restarts = 0;
                }
                if fast_restarts == CORE_MAX_FAST_RESTARTS {
                    log_core(&format!(
                        "le service de fond s'arrête aussitôt relancé ({fast_restarts} tentatives) : \
                         nouvelle tentative toutes les {} s. Cause probable juste au-dessus (node.exe \
                         absent ou bloqué par l'antivirus).",
                        CORE_SLOW_RETRY.as_secs()
                    ));
                }
                if fast_restarts >= CORE_MAX_FAST_RESTARTS {
                    next_try = Instant::now() + CORE_SLOW_RETRY;
                }
                *slot = spawn_core(&handle);
                spawned_at = Instant::now();
            }
        }
        // Si la fermeture arrive pendant qu'un redémarrage vient d'être lancé, tuer aussi ce
        // dernier enfant : RunEvent::Exit ne possède pas le Child local du watchdog.
        stop_core(&handle);
    });
}

// Désactive la Tracking Prevention de WebView2 sur le profil de la fenêtre. Sans ça, Edge bloque
// le stockage tiers (cookies/localStorage) du lecteur YouTube embarqué → l'embed renvoie « Vidéo
// non disponible » (erreur d'auth). Le réglage est au niveau PROFIL → les 2 fenêtres (board en
// onglet + board détaché, même profil) en bénéficient. WebView2 ≥ 110 requis (user en 149).
#[cfg(target_os = "windows")]
fn disable_tracking_prevention(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Profile3, ICoreWebView2_13, COREWEBVIEW2_TRACKING_PREVENTION_LEVEL_NONE,
    };
    use windows_core::Interface;

    let _ = window.with_webview(|webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else { return };
        let Ok(wv13) = core.cast::<ICoreWebView2_13>() else { return };
        let Ok(profile) = wv13.Profile() else { return };
        let Ok(p3) = profile.cast::<ICoreWebView2Profile3>() else { return };
        let _ = p3.SetPreferredTrackingPreventionLevel(COREWEBVIEW2_TRACKING_PREVENTION_LEVEL_NONE);
    });
}

// ── Chemin disque des fichiers déposés depuis l'Explorateur ─────────────────────────────────────
// `dragDropEnabled` (tauri.conf.json) est EXCLUSIF : l'activer fait révoquer par wry les cibles OLE
// de WebView2 (SetAllowExternalDrop(false) + EnumChildWindows/RevokeDragDrop sur chaque enfant) →
// tout le DnD HTML5 interne meurt (réordonnancement des blocs BlockNote/ProseMirror, cartes du
// tiroir Footages). Il reste donc à `false` : WebView2 garde son drop natif et un fichier lâché
// depuis l'Explorateur arrive en `drop` HTML5 normal — mais Chromium masque le chemin des `File`.
// Porte de sortie officielle de WebView2 : `postMessageWithAdditionalObjects` passe les objets File
// au host, où `ICoreWebView2File::Path` rend le chemin absolu. Zéro copie d'octets (un rush de
// 40 Go se référence, ne se recopie pas).
// Le message venu du renderer est un OBJET (pas une string) : le handler IPC de wry n'accepte que
// des strings (`TryGetWebMessageAsString`) et le rejette avant nous → ce canal ne pollue pas l'IPC.

// Fenêtres déjà pourvues du pont (attache idempotente).
struct FilePathBridge(Mutex<std::collections::HashSet<String>>);

#[cfg(target_os = "windows")]
unsafe fn take_pwstr(p: windows_core::PWSTR) -> String {
    if p.is_null() {
        return String::new();
    }
    let s = unsafe { p.to_string() }.unwrap_or_default();
    unsafe { windows::Win32::System::Com::CoTaskMemFree(Some(p.0 as *const core::ffi::c_void)) };
    s
}

#[cfg(target_os = "windows")]
unsafe fn dropped_paths(
    args: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2WebMessageReceivedEventArgs,
) -> Vec<String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs2,
    };
    use windows_core::{Interface, PWSTR};

    unsafe {
        let Ok(args2) = args.cast::<ICoreWebView2WebMessageReceivedEventArgs2>() else {
            return Vec::new();
        };
        let Ok(objs) = args2.AdditionalObjects() else {
            return Vec::new();
        };
        let mut count = 0u32;
        if objs.Count(&mut count).is_err() {
            return Vec::new();
        }
        (0..count)
            .map(|i| {
                // Entrée nulle ou non-File → chaîne vide : l'index reste aligné sur celui du
                // tableau de File côté renderer.
                objs.GetValueAtIndex(i)
                    .ok()
                    .and_then(|o| o.cast::<ICoreWebView2File>().ok())
                    .and_then(|f| {
                        let mut w = PWSTR::null();
                        f.Path(&mut w).ok().map(|_| take_pwstr(w))
                    })
                    .unwrap_or_default()
            })
            .collect()
    }
}

// Branche le pont sur la webview `label`. Appelé paresseusement par le renderer au premier besoin :
// les fenêtres board/carnet détachées naissent côté JS, bien après `setup`.
#[cfg(target_os = "windows")]
#[tauri::command]
fn nr_attach_file_paths(app: AppHandle, label: String) -> bool {
    use tauri::Emitter;
    use webview2_com::WebMessageReceivedEventHandler;
    use windows_core::PWSTR;

    let Some(window) = app.get_webview_window(&label) else {
        return false;
    };
    if !app
        .state::<FilePathBridge>()
        .0
        .lock()
        .unwrap()
        .insert(label.clone())
    {
        return true; // déjà branchée
    }

    let emitter = app.clone();
    let attached = window.with_webview(move |webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else {
            return;
        };
        let mut token = std::mem::zeroed();
        let _ = core.add_WebMessageReceived(
            &WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let json = {
                    let mut raw = PWSTR::null();
                    if args.WebMessageAsJson(&mut raw).is_err() {
                        return Ok(());
                    }
                    take_pwstr(raw)
                };
                let Ok(msg) = serde_json::from_str::<serde_json::Value>(&json) else {
                    return Ok(());
                };
                let Some(id) = msg.get("__nrFiles").and_then(|v| v.as_u64()) else {
                    return Ok(()); // message d'un autre émetteur
                };
                let paths = dropped_paths(&args);
                let _ = emitter.emit(
                    "nr://file-paths",
                    serde_json::json!({ "id": id, "paths": paths }),
                );
                Ok(())
            })),
            &mut token,
        );
    });
    if attached.is_err() {
        app.state::<FilePathBridge>().0.lock().unwrap().remove(&label);
        return false;
    }
    true
}

// Hors Windows le pont n'existe pas : le renderer retombe sur les sélecteurs natifs de fichiers.
#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn nr_attach_file_paths(_app: AppHandle, _label: String) -> bool {
    false
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if let Some(resource) = release_lock_arg() {
        match release_file_lock(&resource) {
            Ok(()) => std::process::exit(0),
            Err(error) => {
                eprintln!("[netsurush] {error}");
                std::process::exit(1);
            }
        }
    }
    // Activer le décodeur HEVC plateforme dans WebView2 (Windows) AVANT la création du webview.
    #[cfg(target_os = "windows")]
    std::env::set_var(
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        "--enable-features=PlatformHEVCDecoderSupport",
    );

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

    // single-instance EN PREMIER (desktop) : route le deep-link `netsurush://` vers l'instance déjà
    // ouverte (obligatoire Windows/Linux pour que le retour OAuth atteigne l'app) + remet au 1er plan.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
            // Retour OAuth à chaud : Windows relance l'exe avec l'URL en argv → on la ré-émet vers
            // le renderer (deepLink.ts écoute `nr-deep-link`), car le plugin deep-link ne déclenche
            // pas onOpenUrl pour l'instance secondaire.
            if let Some(url) = argv.iter().find(|a| a.starts_with("netsurush://")) {
                use tauri::Emitter;
                let _ = app.emit("nr-deep-link", url.clone());
            }
        }));
    }

    builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(CoreProcess(Mutex::new(None)))
        .manage(FilePathBridge(Mutex::new(std::collections::HashSet::new())))
        .manage(state::AppState::new())
        .invoke_handler(tauri::generate_handler![
            nr_attach_file_paths,
            nr_core_port,
            player::commands::control::player_load,
            player::commands::control::player_play,
            player::commands::control::player_pause,
            player::commands::control::player_toggle_pause,
            player::commands::control::player_stop,
            player::commands::control::player_seek,
            player::commands::control::player_seek_relative,
            player::commands::control::player_set_volume,
            player::commands::control::player_set_speed,
            player::commands::control::player_set_audio_meter,
            player::commands::control::player_set_loop_file,
            player::commands::control::player_ab_loop_mark_a,
            player::commands::control::player_ab_loop_mark_b,
            player::commands::control::player_ab_loop_clear,
            player::commands::control::player_get_loop_state,
            player::commands::control::player_get_status,
            player::commands::control::player_get_tracks,
            player::commands::control::player_set_subtitle_track,
            player::commands::control::player_set_audio_track,
            player::commands::control::player_frame_step,
            player::commands::control::player_frame_back_step,
            player::commands::control::player_screenshot,
            player::commands::control::player_get_audio_levels,
            player::commands::control::player_is_available,
            player::commands::window::player_set_geometry,
            player::commands::window::player_show,
            player::commands::window::player_hide,
            player::commands::window::player_hide_surface,
            player::commands::window::player_set_fullscreen,
            player::commands::window::player_is_fullscreen,
            player::commands::window::player_is_visible,
            player::commands::window::player_get_detached_rect,
            player::commands::window::player_move_detached,
            player::commands::window::player_minimize_detached,
            player::commands::window::player_set_detached_pinned,
            player::commands::window::player_is_detached_pinned,
            player::commands::window::player_sync_overlay,
            player::commands::media::player_get_media_info,
            player::commands::media::player_get_frame_preview
        ])
        .setup(|app| {
            // Coffre Stronghold (clés API BYOK du Chat IA) : clé dérivée d'argon2 sur un sel local.
            let salt_path = app
                .path()
                .app_local_data_dir()
                .expect("app_local_data_dir indisponible");
            let _ = std::fs::create_dir_all(&salt_path);
            app.handle().plugin(
                tauri_plugin_stronghold::Builder::with_argon2(&salt_path.join("salt.txt")).build(),
            )?;

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
                // Ouvre les devtools en dev → console webview visible pour diagnostiquer un écran noir.
                #[cfg(debug_assertions)]
                if let Some(w) = app.get_webview_window("main") {
                    w.open_devtools();
                }
            }
            // Lance le service Node "core" (médias + RPC + sidecars + pont Resolve). Tué à la fermeture.
            CORE_SHUTDOWN.store(false, Ordering::Release);
            let child = spawn_core(app.handle());
            *app.state::<CoreProcess>().0.lock().unwrap() = child;
            supervise_core(app.handle());

            let player_state = app.state::<state::AppState>();
            player::bootstrap::initialize_embedded_player(app, &player_state);

            #[cfg(target_os = "windows")]
            if let Some(w) = app.get_webview_window("main") {
                disable_tracking_prevention(&w);
            }

            // Enregistre le scheme `netsurush://` au runtime — requis pour le DEV Windows/Linux
            // (en prod l'installeur NSIS le pose). Best-effort.
            #[cfg(any(windows, target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = app.deep_link().register_all();
            }
            Ok(())
        });

    builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                CORE_SHUTDOWN.store(true, Ordering::Release);
                stop_core(app_handle);
            }
        });
}

// DEV : `node <projet>/core/server.js` (Node du PATH, code du dépôt). Resolve via CARGO_MANIFEST_DIR.
#[cfg(debug_assertions)]
fn spawn_core(_app: &AppHandle) -> Option<Child> {
    let server = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("core")
        .join("server.js");
    if !server.exists() {
        eprintln!("[netsurush] core introuvable: {}", server.display());
        return None;
    }
    let app_exe = std::env::current_exe().ok();
    let port = pick_core_port();
    CORE_PORT.store(port, Ordering::Release);
    let mut command = Command::new("node");
    command.arg(&server).stdin(Stdio::piped()).env("NR_CORE_PORT", port.to_string());
    if let Some(exe) = app_exe { command.env("NETSURUSH_APP_EXE", exe); }
    match command.spawn() {
        Ok(child) => {
            eprintln!("[netsurush] core spawné: {}", server.display());
            Some(child)
        }
        Err(e) => {
            eprintln!("[netsurush] échec spawn core (node dans le PATH ?): {e}");
            None
        }
    }
}

// RELEASE : node.exe portable bundlé (resources/bin) + core bundlé (resources/core). Les sidecars
// python lisent leurs scripts via NETSURUSH_PY_DIR ; config.js localise le runtime provisionné
// (venv/ffmpeg/poids) via nr.config.json dans %LOCALAPPDATA%\NetsuRush (écrit au 1er lancement).
#[cfg(not(debug_assertions))]
fn spawn_core(app: &AppHandle) -> Option<Child> {
    let res = match app.path().resource_dir() {
        Ok(p) => p,
        Err(e) => {
            log_core(&format!("resource_dir introuvable: {e}"));
            return None;
        }
    };
    // resource_dir() renvoie un chemin verbatim `\\?\C:\...` sur Windows ; les consommateurs en aval
    // cassent dessus. Le résolveur de module de Node en fait partie : lancé sur
    // `\\?\C:\…\server.js`, il finit par un `lstat 'C:'` et meurt en `EISDIR` avant d'exécuter la
    // moindre ligne du core (le port n'ouvrait jamais, l'app n'avait qu'un « Failed to fetch »).
    // Le préfixe est donc retiré de TOUT ce qui sort d'ici — arguments comme variables d'env — et
    // pas seulement des env comme avant.
    let strip = |p: &std::path::Path| {
        let s = p.to_string_lossy().to_string();
        s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s)
    };
    let node = PathBuf::from(strip(&res.join("resources").join("bin").join("node.exe")));
    let server = PathBuf::from(strip(&res.join("resources").join("core").join("server.js")));
    let py_dir = res.join("resources").join("python");
    let res_root = res.join("resources");
    if !node.exists() || !server.exists() {
        log_core(&format!(
            "sidecar incomplet — installation à réparer (node.exe présent={}, server.js présent={}, \
             ressources={})",
            node.exists(),
            server.exists(),
            strip(&res_root),
        ));
        return None;
    }
    // Sans console, `Stdio::inherit()` jette la sortie du core : ses erreurs de démarrage (port
    // occupé, module manquant) devenaient invisibles. On la redirige donc vers le journal.
    let (out, err) = match open_core_log() {
        Some(file) => match file.try_clone() {
            Ok(twin) => (Stdio::from(file), Stdio::from(twin)),
            Err(_) => (Stdio::from(file), Stdio::null()),
        },
        None => (Stdio::null(), Stdio::null()),
    };
    let port = pick_core_port();
    CORE_PORT.store(port, Ordering::Release);
    // CREATE_NO_WINDOW (0x08000000) : node.exe est une app console → sans ce flag une fenêtre de
    // terminal s'ouvre à côté de l'app. On la masque ; le core tourne en arrière-plan.
    use std::os::windows::process::CommandExt;
    match Command::new(&node)
        .arg(&server)
        .stdin(Stdio::piped())
        .stdout(out)
        .stderr(err)
        .env("NR_CORE_PORT", port.to_string())
        .env("NETSURUSH_PY_DIR", strip(&py_dir))
        .env("NR_RESOURCE_DIR", strip(&res_root))
        .env("NETSURUSH_APP_EXE", strip(&std::env::current_exe().unwrap_or_default()))
        .env("NODE_ENV", "production")
        .creation_flags(0x0800_0000)
        .spawn()
    {
        Ok(child) => {
            log_core(&format!("service de fond lancé (pid {}, port {port})", child.id()));
            Some(child)
        }
        Err(e) => {
            log_core(&format!("échec spawn core bundlé ({}) : {e}", strip(&node)));
            None
        }
    }
}

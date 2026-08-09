mod cache;
pub mod control;
pub mod media;
mod overlay;
mod parsing;
mod probe;
mod probe_frame;
mod probe_media;
mod shared;
mod tools;
pub mod window;

pub(crate) fn resolve_tool(name: &str) -> std::path::PathBuf {
    tools::resolve_tool(name)
}

pub(crate) fn configure_hidden_process(command: &mut std::process::Command) {
    tools::configure_hidden_process(command)
}

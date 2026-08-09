use super::MpvPlayer;
use crate::player::mpv_ffi::*;
use std::os::raw::{c_double, c_int, c_void};

impl MpvPlayer {
    pub(super) fn execute_command(&self, command: &str) -> Result<(), String> {
        let cmd_c = to_cstring(command);
        let result = unsafe { (self.lib.command_string)(self.handle, cmd_c.as_ptr()) };
        if result < 0 {
            return Err(format!("Failed command `{}`: error {}", command, result));
        }
        Ok(())
    }

    pub(super) fn set_property_double(&self, name: &str, value: f64) -> Result<(), String> {
        let name_c = to_cstring(name);
        let mut val = value;
        let result = unsafe {
            (self.lib.set_property)(
                self.handle,
                name_c.as_ptr(),
                MPV_FORMAT_DOUBLE,
                &mut val as *mut c_double as *mut c_void,
            )
        };
        if result < 0 {
            return Err(format!("Failed to set property {}: error {}", name, result));
        }
        Ok(())
    }

    pub(super) fn set_property_flag(&self, name: &str, value: bool) -> Result<(), String> {
        let name_c = to_cstring(name);
        let mut val: c_int = if value { 1 } else { 0 };
        let result = unsafe {
            (self.lib.set_property)(
                self.handle,
                name_c.as_ptr(),
                MPV_FORMAT_FLAG,
                &mut val as *mut c_int as *mut c_void,
            )
        };
        if result < 0 {
            return Err(format!("Failed to set property {}: error {}", name, result));
        }
        Ok(())
    }

    pub(super) fn set_property_string(&self, name: &str, value: &str) -> Result<(), String> {
        let name_c = to_cstring(name);
        let value_c = to_cstring(value);
        let result = unsafe {
            (self.lib.set_property_string)(self.handle, name_c.as_ptr(), value_c.as_ptr())
        };
        if result < 0 {
            return Err(format!("Failed to set property {}: error {}", name, result));
        }
        Ok(())
    }

    pub(super) fn get_property_double(&self, name: &str) -> Result<f64, String> {
        let name_c = to_cstring(name);
        let mut value: c_double = 0.0;
        let result = unsafe {
            (self.lib.get_property)(
                self.handle,
                name_c.as_ptr(),
                MPV_FORMAT_DOUBLE,
                &mut value as *mut c_double as *mut c_void,
            )
        };
        if result < 0 {
            return Err(format!("Failed to get property {}: error {}", name, result));
        }
        Ok(value)
    }

    pub(super) fn get_property_flag(&self, name: &str) -> Result<bool, String> {
        let name_c = to_cstring(name);
        let mut value: c_int = 0;
        let result = unsafe {
            (self.lib.get_property)(
                self.handle,
                name_c.as_ptr(),
                MPV_FORMAT_FLAG,
                &mut value as *mut c_int as *mut c_void,
            )
        };
        if result < 0 {
            return Err(format!("Failed to get property {}: error {}", name, result));
        }
        Ok(value != 0)
    }

    pub(super) fn get_property_string_safe(&self, name: &str) -> String {
        let name_c = to_cstring(name);
        let ptr = unsafe { (self.lib.get_property_string)(self.handle, name_c.as_ptr()) };
        if ptr.is_null() {
            return String::new();
        }
        let result = from_cstr(ptr);
        unsafe { (self.lib.free)(ptr as *mut c_void) };
        result
    }
}

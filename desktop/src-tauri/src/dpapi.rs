//! Windows DPAPI: mã hoá dữ liệu bằng key gắn với tài khoản Windows đang đăng nhập.
//! Dùng để cất key của vault khi người dùng không đặt master password.

use std::io;
use zeroize::Zeroizing;

/// Entropy phụ, để app khác dùng DPAPI không vô tình giải mã được blob của app này.
#[cfg(windows)]
const ENTROPY: &[u8] = b"com.authenticator.app/vault-key";

#[cfg(windows)]
pub fn protect(data: &[u8]) -> io::Result<Vec<u8>> {
    use std::ptr;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input = blob(data);
    let entropy = blob(ENTROPY);
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };
    let ok = unsafe {
        CryptProtectData(
            &input,
            ptr::null(),
            &entropy,
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { take(output) }.to_vec())
}

#[cfg(windows)]
pub fn unprotect(data: &[u8]) -> io::Result<Zeroizing<Vec<u8>>> {
    use std::ptr;
    use windows_sys::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input = blob(data);
    let entropy = blob(ENTROPY);
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };
    let ok = unsafe {
        CryptUnprotectData(
            &input,
            ptr::null_mut(),
            &entropy,
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { take(output) })
}

#[cfg(windows)]
fn blob(data: &[u8]) -> windows_sys::Win32::Security::Cryptography::CRYPT_INTEGER_BLOB {
    windows_sys::Win32::Security::Cryptography::CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    }
}

/// Copy buffer do Windows cấp phát, xoá trắng rồi giải phóng bằng LocalFree.
#[cfg(windows)]
unsafe fn take(
    output: windows_sys::Win32::Security::Cryptography::CRYPT_INTEGER_BLOB,
) -> Zeroizing<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;

    let len = output.cbData as usize;
    let data = Zeroizing::new(std::slice::from_raw_parts(output.pbData, len).to_vec());
    std::ptr::write_bytes(output.pbData, 0, len);
    LocalFree(output.pbData as _);
    data
}

#[cfg(not(windows))]
pub fn protect(_data: &[u8]) -> io::Result<Vec<u8>> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "DPAPI chỉ có trên Windows"))
}

#[cfg(not(windows))]
pub fn unprotect(_data: &[u8]) -> io::Result<Zeroizing<Vec<u8>>> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "DPAPI chỉ có trên Windows"))
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let secret = b"0123456789abcdef0123456789abcdef";
        let wrapped = protect(secret).unwrap();
        assert_ne!(wrapped.as_slice(), secret.as_slice());
        assert_eq!(unprotect(&wrapped).unwrap().as_slice(), secret.as_slice());
        assert!(unprotect(b"not a dpapi blob").is_err());
    }
}

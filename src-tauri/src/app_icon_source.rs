//! Resolves an app's real icon from its Start Menu shortcut.
//!
//! Packaged apps expose a logo through `AppDisplayInfo`, but plain Win32 apps
//! (Chrome, Notion, classic Outlook, …) do not. Windows shows a toast for such
//! an app only when it has a Start Menu shortcut whose `System.AppUserModel.ID`
//! matches the notification's AUMID, and it draws the app label from that
//! shortcut's target executable. We follow the same trail: map AUMID → shortcut
//! icon, then rasterize that icon to a PNG the webview can display.

use std::{
    ffi::{c_void, OsString},
    fs,
    mem::size_of,
    os::windows::ffi::{OsStrExt, OsStringExt},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use windows::{
    core::{Interface, GUID, PCWSTR},
    Win32::{
        Foundation::PROPERTYKEY,
        Graphics::Gdi::{
            DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO,
            BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP, HGDIOBJ,
        },
        Storage::FileSystem::WIN32_FIND_DATAW,
        System::Com::{
            CoCreateInstance, CoTaskMemFree, IPersistFile,
            StructuredStorage::{PropVariantClear, PropVariantToStringAlloc},
            CLSCTX_INPROC_SERVER, STGM_READ,
        },
        UI::{
            Shell::{
                ExtractIconExW, IShellLinkW, PropertiesSystem::IPropertyStore, ShellLink,
            },
            WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO},
        },
    },
};

// PKEY_AppUserModel_ID — {9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}, pid 5.
const PKEY_APP_USER_MODEL_ID: PROPERTYKEY = PROPERTYKEY {
    fmtid: GUID::from_u128(0x9F4C2855_9F79_4B39_A8D0_E1D42DE1D5F3),
    pid: 5,
};
struct Shortcut {
    aumid: String,
    lnk: PathBuf,
    target: PathBuf,
    icon: PathBuf,
    index: i32,
}
type ShortcutMap = Vec<Shortcut>;
static SHORTCUT_MAP: OnceLock<Mutex<Option<ShortcutMap>>> = OnceLock::new();

fn with_shortcut<R>(aumid: &str, f: impl FnOnce(&Shortcut) -> R) -> Option<R> {
    if aumid.is_empty() {
        return None;
    }
    let cell = SHORTCUT_MAP.get_or_init(|| Mutex::new(None));
    let mut guard = cell.lock().ok()?;
    if guard.is_none() {
        *guard = Some(build_shortcut_map());
    }
    guard
        .as_ref()?
        .iter()
        .find(|shortcut| shortcut.aumid.eq_ignore_ascii_case(aumid))
        .map(f)
}

/// Returns the PNG bytes of the icon the given AUMID's shortcut points at, if any.
pub fn icon_png_for_aumid(aumid: &str) -> Option<Vec<u8>> {
    let (icon, index) = with_shortcut(aumid, |shortcut| (shortcut.icon.clone(), shortcut.index))?;
    unsafe { extract_icon_png(&icon, index) }
}

/// Returns the Start Menu shortcut that launches the given AUMID's app, if any.
pub fn launch_target_for_aumid(aumid: &str) -> Option<PathBuf> {
    with_shortcut(aumid, |shortcut| shortcut.lnk.clone())
}

/// Returns the executable the given AUMID's shortcut runs, used to find an
/// already-open window of that app before launching a fresh one.
pub fn target_exe_for_aumid(aumid: &str) -> Option<PathBuf> {
    with_shortcut(aumid, |shortcut| shortcut.target.clone())
        .filter(|path| !path.as_os_str().is_empty())
}

fn start_menu_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(appdata) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(appdata).join(r"Microsoft\Windows\Start Menu\Programs"));
    }
    if let Some(program_data) = std::env::var_os("ProgramData") {
        dirs.push(PathBuf::from(program_data).join(r"Microsoft\Windows\Start Menu\Programs"));
    }
    dirs
}

fn collect_shortcuts(dir: &Path, out: &mut Vec<PathBuf>, depth: u32) {
    if depth > 8 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_shortcuts(&path, out, depth + 1);
        } else if path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("lnk")) {
            out.push(path);
        }
    }
}

fn build_shortcut_map() -> ShortcutMap {
    let mut shortcuts = Vec::new();
    for dir in start_menu_dirs() {
        collect_shortcuts(&dir, &mut shortcuts, 0);
    }
    let mut map = Vec::new();
    for shortcut in shortcuts {
        if let Some(entry) = unsafe { read_shortcut(&shortcut) } {
            map.push(entry);
        }
    }
    map
}

fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

unsafe fn read_shortcut(path: &Path) -> Option<Shortcut> {
    let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
    let persist: IPersistFile = link.cast().ok()?;
    persist.Load(PCWSTR(wide(path).as_ptr()), STGM_READ).ok()?;

    let store: IPropertyStore = link.cast().ok()?;
    let mut value = store.GetValue(&PKEY_APP_USER_MODEL_ID).ok()?;
    let aumid = PropVariantToStringAlloc(&value)
        .ok()
        .and_then(|raw| {
            let text = raw.to_string().ok();
            CoTaskMemFree(Some(raw.0 as *const c_void));
            text
        })
        .filter(|id| !id.trim().is_empty());
    let _ = PropVariantClear(&mut value);
    let aumid = aumid?;

    // The executable the shortcut launches, used both as an icon fallback and
    // to find an already-open window of the app.
    let mut target_buf = [0u16; 260];
    let target = if link
        .GetPath(&mut target_buf, &mut WIN32_FIND_DATAW::default(), 0)
        .is_ok()
    {
        let len = target_buf.iter().position(|&c| c == 0).unwrap_or(0);
        (len > 0)
            .then(|| PathBuf::from(OsString::from_wide(&target_buf[..len])))
            .unwrap_or_default()
    } else {
        PathBuf::new()
    };

    // Prefer the shortcut's explicit icon; fall back to its target executable.
    let mut icon_buf = [0u16; 260];
    let mut index = 0i32;
    let icon_path = if link.GetIconLocation(&mut icon_buf, &mut index).is_ok() {
        let len = icon_buf.iter().position(|&c| c == 0).unwrap_or(0);
        (len > 0).then(|| PathBuf::from(OsString::from_wide(&icon_buf[..len])))
    } else {
        None
    };
    let icon = match icon_path {
        Some(path) => path,
        None => {
            index = 0;
            if target.as_os_str().is_empty() {
                return None;
            }
            target.clone()
        }
    };
    Some(Shortcut {
        aumid,
        lnk: path.to_path_buf(),
        target,
        icon,
        index,
    })
}

unsafe fn extract_icon_png(source: &Path, index: i32) -> Option<Vec<u8>> {
    let mut icon = HICON::default();
    let extracted = ExtractIconExW(
        PCWSTR(wide(source).as_ptr()),
        index,
        Some(&mut icon),
        None,
        1,
    );
    if extracted == 0 || icon.is_invalid() {
        return None;
    }
    let png = icon_to_png(icon);
    let _ = DestroyIcon(icon);
    png
}

unsafe fn icon_to_png(icon: HICON) -> Option<Vec<u8>> {
    let mut info = ICONINFO::default();
    GetIconInfo(icon, &mut info).ok()?;
    let color = info.hbmColor;
    let mask = info.hbmMask;
    let result = color_bitmap_to_png(color);
    if !color.is_invalid() {
        let _ = DeleteObject(HGDIOBJ(color.0));
    }
    if !mask.is_invalid() {
        let _ = DeleteObject(HGDIOBJ(mask.0));
    }
    result
}

unsafe fn color_bitmap_to_png(bitmap: HBITMAP) -> Option<Vec<u8>> {
    if bitmap.is_invalid() {
        return None;
    }
    let mut info = BITMAP::default();
    if GetObjectW(
        HGDIOBJ(bitmap.0),
        size_of::<BITMAP>() as i32,
        Some(&mut info as *mut _ as *mut c_void),
    ) == 0
    {
        return None;
    }
    let width = info.bmWidth;
    let height = info.bmHeight;
    if width <= 0 || height <= 0 || width > 512 || height > 512 {
        return None;
    }

    let mut header = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height, // top-down
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0 as u32,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut pixels = vec![0u8; (width * height * 4) as usize];
    let hdc = GetDC(None);
    let scanlines = GetDIBits(
        hdc,
        bitmap,
        0,
        height as u32,
        Some(pixels.as_mut_ptr() as *mut c_void),
        &mut header,
        DIB_RGB_COLORS,
    );
    ReleaseDC(None, hdc);
    if scanlines == 0 {
        return None;
    }

    // GDI hands back BGRA; PNG wants RGBA. If the icon carries no alpha channel
    // the bytes come back fully transparent, so treat an all-zero alpha as opaque.
    let mut any_alpha = false;
    for pixel in pixels.chunks_exact_mut(4) {
        pixel.swap(0, 2);
        any_alpha |= pixel[3] != 0;
    }
    if !any_alpha {
        for pixel in pixels.chunks_exact_mut(4) {
            pixel[3] = 255;
        }
    }

    let image = image::RgbaImage::from_raw(width as u32, height as u32, pixels)?;
    encode_trimmed_png(image)
}

/// Re-encodes a PNG with its transparent border cropped, so logos that ship with
/// large padding (common for packaged-app assets) fill the icon box.
pub fn trim_png_bytes(bytes: &[u8]) -> Option<Vec<u8>> {
    let image = image::load_from_memory(bytes).ok()?.to_rgba8();
    encode_trimmed_png(image)
}

fn encode_trimmed_png(image: image::RgbaImage) -> Option<Vec<u8>> {
    let (width, height) = image.dimensions();
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (width, height, 0u32, 0u32);
    for (x, y, pixel) in image.enumerate_pixels() {
        if pixel[3] > 8 {
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x);
            max_y = max_y.max(y);
        }
    }
    let trimmed = if max_x >= min_x && max_y >= min_y {
        image::imageops::crop_imm(&image, min_x, min_y, max_x - min_x + 1, max_y - min_y + 1)
            .to_image()
    } else {
        image
    };
    let mut png = Vec::new();
    trimmed
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .ok()?;
    Some(png)
}

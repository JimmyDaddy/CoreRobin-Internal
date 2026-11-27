use crate::models::ApplicationIcon;

#[cfg(target_os = "macos")]
use std::collections::HashMap;
#[cfg(target_os = "macos")]
use std::fs;
#[cfg(target_os = "macos")]
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::sync::{Mutex, OnceLock};
#[cfg(target_os = "macos")]
use std::time::UNIX_EPOCH;

#[cfg(target_os = "macos")]
const MAX_ICON_BYTES: usize = 1_048_576;
#[cfg(target_os = "macos")]
const ICON_RENDER_SIZE_PX: usize = 96;
#[cfg(target_os = "macos")]
const MAX_CACHED_ICONS: usize = 512;

#[cfg(target_os = "macos")]
#[derive(Clone)]
struct CachedIconEntry {
    modified_at_ms: Option<u64>,
    icon: Option<ApplicationIcon>,
}

#[cfg(target_os = "macos")]
fn icon_cache() -> &'static Mutex<HashMap<PathBuf, CachedIconEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedIconEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn load_application_icon(executable: Option<&str>) -> Option<ApplicationIcon> {
    #[cfg(target_os = "macos")]
    {
        load_macos_application_icon(executable?)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = executable;
        None
    }
}

pub fn load_application_bundle_icon(application_path: &str) -> Option<ApplicationIcon> {
    #[cfg(target_os = "macos")]
    {
        let bundle = fs::canonicalize(application_path).ok()?;
        load_macos_bundle_icon(&bundle)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = application_path;
        None
    }
}

#[cfg(target_os = "macos")]
fn load_macos_application_icon(executable: &str) -> Option<ApplicationIcon> {
    let executable = fs::canonicalize(executable).ok()?;
    let bundle = outermost_app_bundle(&executable)?;
    load_macos_bundle_icon(&bundle)
}

#[cfg(target_os = "macos")]
fn load_macos_bundle_icon(bundle: &Path) -> Option<ApplicationIcon> {
    let modified_at_ms = bundle_fingerprint_mtime(bundle);
    if let Ok(cache) = icon_cache().lock()
        && let Some(entry) = cache.get(bundle)
        && entry.modified_at_ms == modified_at_ms
    {
        return entry.icon.clone();
    }

    let rendered = render_macos_bundle_icon_native(bundle);

    if let Ok(mut cache) = icon_cache().lock() {
        if cache.len() >= MAX_CACHED_ICONS {
            cache.clear();
        }
        cache.insert(
            bundle.to_path_buf(),
            CachedIconEntry {
                modified_at_ms,
                icon: rendered.clone(),
            },
        );
    }
    rendered
}

#[cfg(target_os = "macos")]
fn bundle_fingerprint_mtime(bundle: &Path) -> Option<u64> {
    let info_plist = bundle.join("Contents/Info.plist");
    let meta = fs::metadata(&info_plist)
        .or_else(|_| fs::metadata(bundle))
        .ok()?;
    let modified = meta.modified().ok()?;
    modified
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| u64::try_from(d.as_millis()).ok())
}

#[cfg(target_os = "macos")]
fn render_macos_bundle_icon_native(bundle: &Path) -> Option<ApplicationIcon> {
    use core_foundation::base::TCFType;
    use core_foundation::string::CFString;
    use core_graphics::geometry::{CGPoint, CGRect, CGSize};
    use objc2::msg_send;
    use objc2::rc::{Retained, autoreleasepool};
    use objc2::runtime::AnyObject;
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};
    use std::ffi::c_void;
    use std::ptr;

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGColorSpaceCreateDeviceRGB() -> *mut c_void;
        fn CGColorSpaceRelease(space: *const c_void);
        fn CGBitmapContextCreate(
            data: *mut c_void,
            width: usize,
            height: usize,
            bits_per_component: usize,
            bytes_per_row: usize,
            space: *const c_void,
            bitmap_info: u32,
        ) -> *mut c_void;
        fn CGContextDrawImage(c: *mut c_void, rect: CGRect, image: *const c_void);
        fn CGContextSetInterpolationQuality(c: *mut c_void, quality: i32);
        fn CGBitmapContextCreateImage(c: *mut c_void) -> *mut c_void;
        fn CGContextRelease(c: *const c_void);
        fn CGImageRelease(image: *const c_void);
    }

    #[link(name = "ImageIO", kind = "framework")]
    unsafe extern "C" {
        fn CGImageDestinationCreateWithData(
            data: *mut c_void,
            ty: *const c_void,
            count: usize,
            options: *const c_void,
        ) -> *mut c_void;
        fn CGImageDestinationAddImage(
            idst: *mut c_void,
            image: *const c_void,
            properties: *const c_void,
        );
        fn CGImageDestinationFinalize(idst: *mut c_void) -> bool;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFDataCreateMutable(allocator: *const c_void, capacity: isize) -> *mut c_void;
        fn CFDataGetLength(the_data: *const c_void) -> isize;
        fn CFDataGetBytePtr(the_data: *const c_void) -> *const u8;
        fn CFRelease(cf: *const c_void);
    }

    // kCGImageAlphaPremultipliedLast = 1, kCGInterpolationHigh = 3
    const K_CG_IMAGE_ALPHA_PREMULTIPLIED_LAST: u32 = 1;
    const K_CG_INTERPOLATION_HIGH: i32 = 3;

    struct CfGuard(*const c_void);
    impl Drop for CfGuard {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CFRelease(self.0) };
            }
        }
    }
    struct CgColorSpaceGuard(*const c_void);
    impl Drop for CgColorSpaceGuard {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CGColorSpaceRelease(self.0) };
            }
        }
    }
    struct CgContextGuard(*const c_void);
    impl Drop for CgContextGuard {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CGContextRelease(self.0) };
            }
        }
    }
    struct CgImageGuard(*const c_void);
    impl Drop for CgImageGuard {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CGImageRelease(self.0) };
            }
        }
    }

    let path_str = bundle.to_str()?;
    autoreleasepool(|_| {
        let workspace = NSWorkspace::sharedWorkspace();
        let ns_path = NSString::from_str(path_str);
        let ns_image: Option<Retained<AnyObject>> =
            unsafe { msg_send![&workspace, iconForFile: &*ns_path] };
        let ns_image = ns_image?;

        let mut proposed_rect = NSRect::new(
            NSPoint::new(0.0, 0.0),
            NSSize::new(ICON_RENDER_SIZE_PX as f64, ICON_RENDER_SIZE_PX as f64),
        );
        let source_cg_image: *const c_void = unsafe {
            msg_send![
                &ns_image,
                CGImageForProposedRect: &mut proposed_rect,
                context: ptr::null::<AnyObject>(),
                hints: ptr::null::<AnyObject>()
            ]
        };
        if source_cg_image.is_null() {
            return None;
        }

        let color_space = unsafe { CGColorSpaceCreateDeviceRGB() };
        if color_space.is_null() {
            return None;
        }
        let _space_guard = CgColorSpaceGuard(color_space);

        let bytes_per_row = ICON_RENDER_SIZE_PX * 4;
        let bitmap_ctx = unsafe {
            CGBitmapContextCreate(
                ptr::null_mut(),
                ICON_RENDER_SIZE_PX,
                ICON_RENDER_SIZE_PX,
                8,
                bytes_per_row,
                color_space,
                K_CG_IMAGE_ALPHA_PREMULTIPLIED_LAST,
            )
        };
        if bitmap_ctx.is_null() {
            return None;
        }
        let _ctx_guard = CgContextGuard(bitmap_ctx);

        let dest_rect = CGRect::new(
            &CGPoint::new(0.0, 0.0),
            &CGSize::new(ICON_RENDER_SIZE_PX as f64, ICON_RENDER_SIZE_PX as f64),
        );
        let scaled_cg_image = unsafe {
            CGContextSetInterpolationQuality(bitmap_ctx, K_CG_INTERPOLATION_HIGH);
            CGContextDrawImage(bitmap_ctx, dest_rect, source_cg_image);
            CGBitmapContextCreateImage(bitmap_ctx)
        };
        if scaled_cg_image.is_null() {
            return None;
        }
        let _scaled_guard = CgImageGuard(scaled_cg_image);

        let mutable_data = unsafe { CFDataCreateMutable(ptr::null(), 0) };
        if mutable_data.is_null() {
            return None;
        }
        let _data_guard = CfGuard(mutable_data);

        let png_uti = CFString::from_static_string("public.png");
        let dest = unsafe {
            CGImageDestinationCreateWithData(
                mutable_data,
                png_uti.as_concrete_TypeRef().cast(),
                1,
                ptr::null(),
            )
        };
        if dest.is_null() {
            return None;
        }
        let _dest_guard = CfGuard(dest);

        let finalized = unsafe {
            CGImageDestinationAddImage(dest, scaled_cg_image, ptr::null());
            CGImageDestinationFinalize(dest)
        };
        if !finalized {
            return None;
        }

        let len = unsafe { CFDataGetLength(mutable_data) };
        if len <= 0 || (len as usize) > MAX_ICON_BYTES {
            return None;
        }
        let ptr = unsafe { CFDataGetBytePtr(mutable_data) };
        if ptr.is_null() {
            return None;
        }
        let bytes = unsafe { std::slice::from_raw_parts(ptr, len as usize) }.to_vec();
        if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            return None;
        }

        Some(ApplicationIcon {
            mime_type: "image/png".to_owned(),
            bytes,
        })
    })
}

#[cfg(target_os = "macos")]
fn outermost_app_bundle(executable: &Path) -> Option<PathBuf> {
    executable
        .ancestors()
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))
        })
        .last()
        .map(Path::to_path_buf)
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::{load_application_bundle_icon, outermost_app_bundle};
    use std::path::Path;
    use std::time::Instant;

    #[test]
    fn chooses_the_outer_application_bundle_for_helper_processes() {
        let executable = Path::new(
            "/Applications/Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper",
        );
        assert_eq!(
            outermost_app_bundle(executable).as_deref(),
            Some(Path::new("/Applications/Code.app")),
        );
    }

    #[test]
    fn loads_native_macos_bundle_icon_as_png_and_caches_subsequent_calls() {
        let candidate = [
            "/System/Applications/Calculator.app",
            "/System/Applications/TextEdit.app",
            "/System/Library/CoreServices/Finder.app",
        ]
        .into_iter()
        .find(|path| Path::new(path).is_dir());
        let Some(app_path) = candidate else {
            return;
        };

        let first_started = Instant::now();
        let first = load_application_bundle_icon(app_path).expect("native icon PNG");
        let first_ms = first_started.elapsed();
        assert_eq!(first.mime_type, "image/png");
        assert!(first.bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
        assert!(first.bytes.len() > 256);

        let second_started = Instant::now();
        let second = load_application_bundle_icon(app_path).expect("cached icon PNG");
        let second_ms = second_started.elapsed();
        assert_eq!(first.bytes, second.bytes);
        assert!(
            second_ms <= first_ms.saturating_add(std::time::Duration::from_millis(2)),
            "cached call ({second_ms:?}) should not be slower than uncached render ({first_ms:?})"
        );
    }
}

#[cfg(target_os = "macos")]
use std::fs;
#[cfg(target_os = "macos")]
use std::path::{Path, PathBuf};

#[cfg(target_os = "macos")]
const LOCALIZED_NAME_KEYS: [&str; 2] = ["CFBundleDisplayName", "CFBundleName"];
#[cfg(target_os = "macos")]
const MAX_INFO_PLIST_STRINGS_BYTES: u64 = 1_048_576;

#[cfg(target_os = "macos")]
pub fn bundle_display_name(
    bundle: &Path,
    dictionary: &plist::Dictionary,
    preferred_language: Option<&str>,
) -> String {
    localized_bundle_name(bundle, preferred_language)
        .or_else(|| {
            LOCALIZED_NAME_KEYS.iter().find_map(|key| {
                dictionary
                    .get(key)
                    .and_then(plist::Value::as_string)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned)
            })
        })
        .or_else(|| {
            bundle
                .file_stem()
                .map(|value| value.to_string_lossy().into_owned())
                .filter(|value| !value.trim().is_empty())
        })
        .unwrap_or_else(|| bundle.to_string_lossy().into_owned())
}

#[cfg(target_os = "macos")]
pub fn bundle_icon_path(bundle: &Path) -> Option<PathBuf> {
    let canonical_bundle = fs::canonicalize(bundle).ok()?;
    if !canonical_bundle.is_dir()
        || !canonical_bundle
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))
    {
        return None;
    }
    let resources = canonical_bundle.join("Contents/Resources");
    let plist = plist::Value::from_file(canonical_bundle.join("Contents/Info.plist")).ok();
    let named_icon = plist
        .as_ref()
        .and_then(plist::Value::as_dictionary)
        .and_then(|dictionary| {
            dictionary
                .get("CFBundleIconFile")
                .or_else(|| dictionary.get("CFBundleIconName"))
                .and_then(plist::Value::as_string)
                .map(PathBuf::from)
                .or_else(|| primary_icon_file(dictionary))
        })
        .map(|name| {
            if name.extension().is_some() {
                name
            } else {
                name.with_extension("icns")
            }
        });
    let candidate = named_icon
        .map(|name| resources.join(name))
        .filter(|path| path.is_file())
        .or_else(|| first_icns_file(&resources))?;
    let candidate = fs::canonicalize(candidate).ok()?;
    candidate
        .starts_with(&canonical_bundle)
        .then_some(candidate)
}

#[cfg(target_os = "macos")]
fn localized_bundle_name(bundle: &Path, preferred_language: Option<&str>) -> Option<String> {
    let language = preferred_language?.trim();
    if language.is_empty() || language.len() > 64 {
        return None;
    }
    let resources = bundle.join("Contents/Resources");
    matching_localization_directories(&resources, language)
        .into_iter()
        .find_map(|localization| localized_name_from_directory(&localization))
}

#[cfg(target_os = "macos")]
fn localized_name_from_directory(localization: &Path) -> Option<String> {
    let strings_path = localization.join("InfoPlist.strings");
    let metadata = fs::symlink_metadata(&strings_path).ok()?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_INFO_PLIST_STRINGS_BYTES
    {
        return None;
    }

    if let Ok(value) = plist::Value::from_file(&strings_path)
        && let Some(dictionary) = value.as_dictionary()
        && let Some(name) = LOCALIZED_NAME_KEYS.iter().find_map(|key| {
            dictionary
                .get(key)
                .and_then(plist::Value::as_string)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        })
    {
        return Some(name);
    }

    let bytes = fs::read(strings_path).ok()?;
    let contents = decode_strings_file(&bytes)?;
    LOCALIZED_NAME_KEYS
        .iter()
        .find_map(|key| strings_assignment(&contents, key))
}

#[cfg(target_os = "macos")]
fn matching_localization_directories(resources: &Path, language: &str) -> Vec<PathBuf> {
    let available = fs::read_dir(resources)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter_map(|entry| {
            if !entry.file_type().ok()?.is_dir() {
                return None;
            }
            let path = entry.path();
            let name = path.file_name()?.to_str()?;
            let locale = name.strip_suffix(".lproj")?.to_owned();
            Some((locale, path))
        })
        .collect::<Vec<_>>();

    let mut matches = Vec::new();
    for candidate in language_candidates(language) {
        for (_, path) in available
            .iter()
            .filter(|(locale, _)| locale_matches(locale, &candidate))
        {
            if !matches.contains(path) {
                matches.push(path.clone());
            }
        }
    }
    matches
}

#[cfg(target_os = "macos")]
fn language_candidates(language: &str) -> Vec<String> {
    let normalized = normalize_locale(language);
    let mut candidates = Vec::new();
    let mapped: &[&str] = if matches!(normalized.as_str(), "zh-cn" | "zh-hans" | "zh-sg") {
        &["zh-Hans", "zh_CN", "zh-CN", "zh"]
    } else if matches!(normalized.as_str(), "zh-tw" | "zh-hk" | "zh-mo" | "zh-hant") {
        &["zh-Hant", "zh_TW", "zh-TW", "zh_HK", "zh-HK", "zh"]
    } else if normalized == "pt-br" {
        &["pt-BR", "pt_BR", "pt"]
    } else {
        &[]
    };
    for candidate in mapped {
        push_unique(&mut candidates, candidate);
    }
    push_unique(&mut candidates, language);
    if let Some(base) = normalized.split('-').next() {
        push_unique(&mut candidates, base);
    }
    push_unique(&mut candidates, "Base");
    candidates
}

#[cfg(target_os = "macos")]
fn push_unique(candidates: &mut Vec<String>, candidate: &str) {
    if !candidate.is_empty()
        && !candidates
            .iter()
            .any(|existing| locale_matches(existing, candidate))
    {
        candidates.push(candidate.to_owned());
    }
}

#[cfg(target_os = "macos")]
fn locale_matches(left: &str, right: &str) -> bool {
    normalize_locale(left) == normalize_locale(right)
}

#[cfg(target_os = "macos")]
fn normalize_locale(value: &str) -> String {
    value.trim().replace('_', "-").to_ascii_lowercase()
}

#[cfg(target_os = "macos")]
fn decode_strings_file(bytes: &[u8]) -> Option<String> {
    if let Some(data) = bytes.strip_prefix(&[0xff, 0xfe]) {
        let units = data
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        return String::from_utf16(&units).ok();
    }
    if let Some(data) = bytes.strip_prefix(&[0xfe, 0xff]) {
        let units = data
            .chunks_exact(2)
            .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        return String::from_utf16(&units).ok();
    }
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    String::from_utf8(bytes.to_vec()).ok()
}

#[cfg(target_os = "macos")]
fn strings_assignment(contents: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    let mut remaining = contents;
    while let Some(key_offset) = remaining.find(&needle) {
        let after_key = &remaining[key_offset + needle.len()..];
        let assignment_offset = after_key.find('=')?;
        let before_assignment = &after_key[..assignment_offset];
        if before_assignment.contains(';') {
            remaining = &after_key[assignment_offset + 1..];
            continue;
        }
        let value = parse_quoted_value(&after_key[assignment_offset + 1..])?;
        let value = value.trim().to_owned();
        if !value.is_empty() {
            return Some(value);
        }
        remaining = &after_key[assignment_offset + 1..];
    }
    None
}

#[cfg(target_os = "macos")]
fn parse_quoted_value(value: &str) -> Option<String> {
    let mut characters = value
        .chars()
        .skip_while(|character| character.is_whitespace());
    if characters.next()? != '"' {
        return None;
    }
    let mut output = String::new();
    let mut escaped = false;
    for character in characters {
        if escaped {
            output.push(match character {
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                other => other,
            });
            escaped = false;
        } else if character == '\\' {
            escaped = true;
        } else if character == '"' {
            return Some(output);
        } else {
            output.push(character);
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn primary_icon_file(dictionary: &plist::Dictionary) -> Option<PathBuf> {
    dictionary
        .get("CFBundleIcons")?
        .as_dictionary()?
        .get("CFBundlePrimaryIcon")?
        .as_dictionary()?
        .get("CFBundleIconFiles")?
        .as_array()?
        .iter()
        .rev()
        .find_map(plist::Value::as_string)
        .map(PathBuf::from)
}

#[cfg(target_os = "macos")]
fn first_icns_file(resources: &Path) -> Option<PathBuf> {
    let mut icons = fs::read_dir(resources)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("icns"))
        })
        .collect::<Vec<_>>();
    icons.sort();
    icons.into_iter().next()
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::{bundle_display_name, bundle_icon_path};
    use plist::{Dictionary, Value};
    use std::fs;
    use std::path::PathBuf;
    use tempfile::TempDir;

    #[test]
    fn uses_utf16_localized_bundle_name_for_preferred_language() {
        let root = TempDir::new().unwrap();
        let bundle = example_bundle(root.path());
        let localization = bundle.join("Contents/Resources/zh-Hans.lproj");
        fs::create_dir_all(&localization).unwrap();
        let localized = r#""CFBundleDisplayName" = "示例应用";"#;
        let mut bytes = vec![0xff, 0xfe];
        bytes.extend(localized.encode_utf16().flat_map(u16::to_le_bytes));
        fs::write(localization.join("InfoPlist.strings"), bytes).unwrap();

        let mut dictionary = Dictionary::new();
        dictionary.insert(
            "CFBundleName".to_owned(),
            Value::String("Example".to_owned()),
        );
        assert_eq!(
            bundle_display_name(&bundle, &dictionary, Some("zh-CN")),
            "示例应用"
        );
    }

    #[test]
    fn falls_back_to_info_plist_name_when_localization_is_missing() {
        let root = TempDir::new().unwrap();
        let bundle = example_bundle(root.path());
        let mut dictionary = Dictionary::new();
        dictionary.insert(
            "CFBundleName".to_owned(),
            Value::String("Example".to_owned()),
        );
        assert_eq!(
            bundle_display_name(&bundle, &dictionary, Some("ja")),
            "Example"
        );
    }

    #[test]
    fn resolves_the_declared_bundle_icon_without_leaving_the_bundle() {
        let root = TempDir::new().unwrap();
        let bundle = example_bundle(root.path());
        let resources = bundle.join("Contents/Resources");
        fs::create_dir_all(&resources).unwrap();
        fs::write(
            bundle.join("Contents/Info.plist"),
            r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleIconFile</key><string>ExampleIcon</string></dict></plist>"#,
        )
        .unwrap();
        fs::write(resources.join("ExampleIcon.icns"), b"test").unwrap();

        assert_eq!(
            bundle_icon_path(&bundle).as_deref(),
            fs::canonicalize(resources.join("ExampleIcon.icns"))
                .ok()
                .as_deref(),
        );
    }

    fn example_bundle(root: &std::path::Path) -> PathBuf {
        let bundle = root.join("Example.app");
        fs::create_dir_all(bundle.join("Contents/Resources")).unwrap();
        bundle
    }
}

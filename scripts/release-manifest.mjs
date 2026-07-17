export function buildReleaseManifest(release) {
  if (!release?.tag_name || !Array.isArray(release.assets)) {
    throw new Error("A GitHub release with tag_name and assets is required.");
  }

  const installers = release.assets
    .map(classifyInstaller)
    .filter(Boolean)
    .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name))
    .map((asset) => {
      delete asset.order;
      return asset;
    });
  const evidence = release.assets
    .filter((asset) => ["SHA256SUMS", "SHA256SUMS.sigstore.json", "corerobin.spdx.json"].includes(asset.name))
    .map((asset) => ({ name: asset.name, size: asset.size, url: asset.browser_download_url }));

  if (installers.length === 0) throw new Error(`Release ${release.tag_name} does not contain any recognized installers.`);
  if (evidence.length !== 3) throw new Error(`Release ${release.tag_name} is missing verification evidence.`);

  return {
    schemaVersion: 1,
    tagName: release.tag_name,
    name: release.name || `CoreRobin ${release.tag_name}`,
    publishedAt: release.published_at,
    releaseUrl: release.html_url,
    installers,
    evidence,
  };
}

function classifyInstaller(asset) {
  const base = {
    name: asset.name,
    size: asset.size,
    sha256: asset.digest?.replace(/^sha256:/, "") ?? null,
    url: asset.browser_download_url,
  };
  if (/^CoreRobin_.*_aarch64\.dmg$/i.test(asset.name)) {
    return { ...base, id: "macos-arm64-dmg", platform: "macos", architecture: "Apple Silicon", format: "DMG", status: "tested", order: 10 };
  }
  if (/^CoreRobin_.*_x64\.dmg$/i.test(asset.name)) {
    return { ...base, id: "macos-x64-dmg", platform: "macos", architecture: "Intel", format: "DMG", status: "tested", order: 20 };
  }
  if (/^CoreRobin_.*_x64-setup\.exe$/i.test(asset.name)) {
    return { ...base, id: "windows-x64-exe", platform: "windows", architecture: "x64", format: "EXE", status: "preview", order: 30 };
  }
  if (/^CoreRobin_.*_x64_en-US\.msi$/i.test(asset.name)) {
    return { ...base, id: "windows-x64-msi", platform: "windows", architecture: "x64", format: "MSI", status: "preview", order: 40 };
  }
  if (/^CoreRobin_.*_amd64\.AppImage$/i.test(asset.name)) {
    return { ...base, id: "linux-x64-appimage", platform: "linux", architecture: "x64", format: "AppImage", status: "preview", order: 50 };
  }
  if (/^CoreRobin_.*_amd64\.deb$/i.test(asset.name)) {
    return { ...base, id: "linux-x64-deb", platform: "linux", architecture: "x64", format: "DEB", status: "preview", order: 60 };
  }
  return null;
}

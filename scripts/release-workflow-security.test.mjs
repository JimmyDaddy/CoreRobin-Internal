import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const releaseWorkflow = readFileSync(".github/workflows/release.yml", "utf8");
const finalizeWorkflow = readFileSync(".github/workflows/finalize-release.yml", "utf8");
const promoteWorkflow = readFileSync(".github/workflows/promote-release.yml", "utf8");
const tauriConfig = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const macOSPackageVerifier = readFileSync("scripts/verify-packaged-macos.sh", "utf8");
const releaseNotesRenderer = readFileSync("scripts/render-release-notes.mjs", "utf8");
const updaterManifestGenerator = readFileSync("scripts/generate-updater-manifest.mjs", "utf8");
const workflowFiles = readdirSync(".github/workflows")
  .filter((name) => /\.ya?ml$/.test(name))
  .sort()
  .map((name) => readFileSync(`.github/workflows/${name}`, "utf8"));

describe("release workflow privilege separation", () => {
  it("allows update checks only against the official public-site origin", () => {
    const csp = tauriConfig.app.security.csp;
    expect(csp).toContain("connect-src ipc: http://ipc.localhost ws://localhost:1421 https://monitor-app.corerobin.com");
    expect(csp).not.toMatch(/connect-src[^;]*https:\*/);
    expect(csp).not.toMatch(/connect-src[^;]*\*/);
  });

  it("pins every third-party action to a full commit SHA", () => {
    const actionReferences = workflowFiles.flatMap((workflow) =>
      [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1]),
    );
    const thirdPartyReferences = actionReferences.filter(
      (reference) => !reference.startsWith("./"),
    );
    expect(thirdPartyReferences.length).toBeGreaterThan(0);
    for (const reference of thirdPartyReferences) {
      expect(reference).toMatch(/^[^@\s]+@[0-9a-f]{40}$/);
    }
  });

  it("keeps local action references inside the repository actions directory", () => {
    const localReferences = workflowFiles.flatMap((workflow) =>
      [...workflow.matchAll(/^\s*uses:\s*(\.\/[^\s#]+)/gm)].map((match) => match[1]),
    );
    for (const reference of localReferences) {
      expect(reference).toMatch(/^\.\/\.github\/actions\/[a-z0-9][a-z0-9/_-]*$/);
    }
  });

  it("keeps repository write permission and the public release token out of build jobs", () => {
    for (const jobName of ["verify", "build", "build_macos_github", "package", "sign"]) {
      const job = workflowJob(releaseWorkflow, jobName);
      expect(job).not.toContain("contents: write");
      expect(job).not.toContain("secrets.GITHUB_TOKEN");
      expect(job).not.toContain("secrets.PUBLIC_RELEASE_TOKEN");
      expect(job).not.toContain("secrets.PUBLIC_RELEASE_READ_TOKEN");
    }
    expect(workflowJob(releaseWorkflow, "verify")).toContain("contents: read");
    expect(workflowJob(releaseWorkflow, "build")).toContain("contents: read");
  });

  it("exposes updater signing secrets only to isolated platform build jobs", () => {
    const build = workflowJob(releaseWorkflow, "build");
    const macOSBuild = workflowJob(releaseWorkflow, "build_macos_github");
    for (const job of [build, macOSBuild]) {
      expect(job).toContain("secrets.TAURI_SIGNING_PRIVATE_KEY");
      expect(job).toContain("secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD");
      expect(job).toContain("test -n \"$TAURI_SIGNING_PRIVATE_KEY\"");
      expect(job).toContain("uploadUpdaterJson: false");
    }
    expect(build).toContain("Build non-macOS installer");
    expect(build).toContain("workflowArtifactNamePattern: ${{ matrix.artifact }}-[bundle]-[ext]");
    expect(build).toContain("Upload updater signature explicitly");
    expect(build).toContain("if-no-files-found: error");
    expect(macOSBuild).toContain("Build Developer ID signed macOS installer and updater");
    for (const jobName of ["verify", "import_macos_local", "package", "sign", "publish"]) {
      expect(workflowJob(releaseWorkflow, jobName)).not.toContain("secrets.TAURI_SIGNING_PRIVATE_KEY");
    }
  });

  it("exposes Apple signing and notarization secrets only to macOS build steps", () => {
    const macOSBuild = workflowJob(releaseWorkflow, "build_macos_github");
    for (const secret of [
      "APPLE_CERTIFICATE",
      "APPLE_CERTIFICATE_PASSWORD",
      "APPLE_API_PRIVATE_KEY_BASE64",
      "APPLE_API_KEY",
      "APPLE_API_ISSUER",
      "APPLE_TEAM_ID",
    ]) {
      expect(macOSBuild).toContain(`secrets.${secret}`);
      for (const jobName of ["verify", "build", "import_macos_local", "package", "sign", "publish"]) {
        expect(workflowJob(releaseWorkflow, jobName)).not.toContain(`secrets.${secret}`);
      }
    }
    expect(macOSBuild).toContain("Prepare Apple signing and notarization credentials");
    expect(macOSBuild).toContain("COREROBIN_NOTARY_KEY_PATH");
    expect(macOSBuild).toContain("Build Developer ID signed macOS installer and updater");
    expect(macOSBuild).toContain("Submit macOS DMG for asynchronous notarization");
    expect(macOSBuild).not.toContain("secrets.APPLE_ID");
    expect(macOSBuild).not.toContain("secrets.APPLE_PASSWORD");
  });

  it("uses asynchronous hosted macOS builds by default and keeps local import explicit", () => {
    const build = workflowJob(releaseWorkflow, "build");
    const macOSBuild = workflowJob(releaseWorkflow, "build_macos_github");
    const localImport = workflowJob(releaseWorkflow, "import_macos_local");
    const packageJob = workflowJob(releaseWorkflow, "package");
    expect(releaseWorkflow).toContain("default: github");
    expect(build).not.toContain("macos-latest");
    expect(macOSBuild).toContain("runs-on: macos-latest");
    expect(macOSBuild).toContain("github.event_name == 'push' || inputs.macos_builder == 'github'");
    expect(localImport).toContain("github.event_name == 'workflow_dispatch' && inputs.macos_builder == 'local'");
    expect(localImport).toContain("scripts/local-macos-release-manifest.mjs verify");
    expect(localImport).toContain("secrets.PUBLIC_RELEASE_READ_TOKEN");
    expect(localImport).not.toContain("secrets.PUBLIC_RELEASE_TOKEN");
    expect(localImport).toContain("gh release download");
    expect(localImport).not.toContain("gh release upload");
    expect(localImport).not.toContain("gh release create");
    expect(localImport).not.toContain("gh release edit");
    expect(packageJob).toContain("needs.import_macos_local.result == 'success'");
    expect(packageJob).not.toContain("needs.build_macos_github.result == 'success'");
  });

  it("uses OIDC only in the signing job", () => {
    const sign = workflowJob(releaseWorkflow, "sign");
    expect(sign).toContain("id-token: write");
    expect(sign).toContain("cosign sign-blob");
    expect(sign).toContain("cosign verify-blob");
    expect(sign).toContain("SHA256SUMS.sigstore.json");
    expect(workflowJob(releaseWorkflow, "publish")).not.toContain("id-token: write");
  });

  it("stages a public draft without bypassing the promotion authorization gate", () => {
    const publish = workflowJob(releaseWorkflow, "publish");
    expect(publish).toContain("name: release");
    expect(publish).toContain("contents: read");
    expect(publish).not.toContain("contents: write");
    expect(publish).toContain("secrets.PUBLIC_RELEASE_TOKEN");
    expect(publish).not.toContain("secrets.GITHUB_TOKEN");
    expect(releaseWorkflow).toContain(
      "PUBLIC_RELEASE_REPOSITORY: JimmyDaddy/corerobin-monitor",
    );
    expect(publish).toContain("sha256sum --check");
    expect(publish).toContain("cosign verify-blob");
    expect(publish).toContain("Render release notes from changelog");
    expect(publish).toContain("--notes-file release-notes.md");
    expect(publish).toContain('--repo "$PUBLIC_RELEASE_REPOSITORY"');
    expect(publish).toContain("--draft");
    expect(publish).not.toContain("--draft=false");
    expect(publish).not.toContain("--latest");
    expect(publish).not.toContain("Update public download manifest");

    const finalizedPublish = workflowJob(finalizeWorkflow, "publish");
    expect(finalizedPublish).toContain("name: release");
    expect(finalizedPublish).toContain("secrets.PUBLIC_RELEASE_TOKEN");
    expect(finalizedPublish).toContain("cosign verify-blob");
    expect(finalizedPublish).toContain("--draft");
    expect(finalizedPublish).not.toContain("--draft=false");
    expect(finalizedPublish).not.toContain("--latest");

    const promote = workflowJob(promoteWorkflow, "promote");
    expect(promote).toContain("name: release");
    expect(promote).toContain("secrets.PUBLIC_RELEASE_TOKEN");
    expect(promoteWorkflow).toContain("promotion_mode:");
    expect(promoteWorkflow).toContain("device-evidence");
    expect(promoteWorkflow).toContain("maintainer-attestation");
    expect(promote).toContain("verify-release-smoke-evidence.mjs");
    expect(promote).toContain("create-maintainer-release-attestation.mjs");
    expect(promote).toContain("release-maintainer-attestation-${{ steps.source.outputs.commit }}");
    expect(promote).toContain("retention-days: 90");
    expect(promote).toContain("sha256sum --check SHA256SUMS");
    expect(promote).toContain("Validate promotion authorization mode");
    expect(promote).toContain("cosign verify-blob");
    expect(promote).toContain("SHA256SUMS.sigstore.json");
    expect(promote).toContain("--draft=false");
    expect(promote).toContain("--latest");
    expect(promote).toContain("Validate public website release data");
    expect(promote).toContain("Publish public website release data");
    expect(promote).toContain("--check");
    expect(promote).toContain("finalize-release.yml@refs/heads/main");
    expect(promote).not.toContain("id-token: write");
  });

  it("Developer ID signs Preview bundles and validates notarized bundles only during finalization", () => {
    const build = workflowJob(releaseWorkflow, "build_macos_github");
    const finalize = workflowJob(finalizeWorkflow, "finalize_macos");
    expect(tauriConfig.identifier).toBe("com.corerobin.monitor");
    expect(tauriConfig.bundle.macOS.signingIdentity).toBeUndefined();
    expect(tauriConfig.bundle.macOS.hardenedRuntime).toBe(true);
    expect(build).not.toContain("--no-sign");
    expect(build).toContain("scripts/verify-packaged-macos.sh");
    expect(build).toContain("com.corerobin.monitor");
    expect(build).toContain('"$APPLE_TEAM_ID"');
    expect(build).toContain("--bundles app,dmg");
    expect(build).toContain("xcrun notarytool submit");
    expect(build).toContain("signed-preview");
    expect(build).not.toContain("xcrun stapler staple");
    expect(build).toContain("Upload pre-staple macOS installer, updater, and notarization state");
    expect(finalize).toContain("xcrun notarytool info");
    expect(finalize).toContain("xcrun stapler staple");
    expect(finalize).toContain("scripts/verify-packaged-macos.sh");
    expect(macOSPackageVerifier).toContain("codesign --verify --deep --strict");
    expect(macOSPackageVerifier).toContain("Authority=Developer ID Application:");
    expect(macOSPackageVerifier).toContain("runtime");
    expect(macOSPackageVerifier).toContain("grep -E 'flags=");
    expect(macOSPackageVerifier).not.toContain("grep -E '^flags=");
    expect(macOSPackageVerifier).toContain("does not enable Hardened Runtime");
    expect(macOSPackageVerifier).toContain("xcrun stapler validate");
    expect(macOSPackageVerifier).toContain("spctl --assess --type open");
    expect(macOSPackageVerifier).toContain("spctl --assess --type execute");
    expect(macOSPackageVerifier).not.toContain("Signature=adhoc");
    expect(macOSPackageVerifier).toContain("hdiutil attach");
    expect(macOSPackageVerifier).toContain("lipo -archs");
  });

  it("submits Apple notarization asynchronously and never polls on the build runner", () => {
    const build = workflowJob(releaseWorkflow, "build_macos_github");
    const finalize = workflowJob(finalizeWorkflow, "finalize_macos");
    expect(build).toContain("timeout-minutes: 75");
    expect(build).toContain("xcrun notarytool submit");
    expect(build).toContain("--webhook");
    expect(build).toContain("APPLE_NOTARY_WEBHOOK_URL");
    expect(build).toContain("scripts/macos-notarization-state.mjs create");
    expect(build).toContain("submission_id");
    expect(build).not.toContain("xcrun notarytool info");
    expect(build).not.toContain("sleep 20");
    expect(build).not.toContain("--wait");
    expect(finalize).toContain("timeout-minutes: 20");
    expect(finalize).toContain("xcrun notarytool info");
    expect(finalize).toContain("status != Accepted");
    expect(finalize).not.toContain("sleep 20");
    expect(finalize).not.toContain("--wait");
  });

  it("publishes Preview as a separate manual-only prerelease", () => {
    const preview = workflowJob(releaseWorkflow, "preview");
    expect(preview).toContain("secrets.PUBLIC_RELEASE_TOKEN");
    expect(preview).toContain("prepare-preview-assets.mjs");
    expect(preview).toContain("render-preview-release-notes.mjs");
    expect(preview).toContain("--prerelease");
    expect(preview).toContain("--latest=false");
    expect(preview).toContain("-preview.1");
    expect(preview).toContain("test ! -e preview-assets/latest.json");
    expect(preview).not.toContain("--clobber");
    expect(preview).not.toContain("generate-updater-manifest.mjs");
    expect(preview).not.toContain("Update public download manifest");
    expect(preview).toContain("signal=preview_ready");
    expect(preview).toContain("APPLE_NOTARY_WEBHOOK_URL");
  });

  it("treats webhook dispatch as a wake-up signal and revalidates trusted state", () => {
    const resolve = workflowJob(finalizeWorkflow, "resolve");
    const finalize = workflowJob(finalizeWorkflow, "finalize_macos");
    const packageJob = workflowJob(finalizeWorkflow, "package");
    const sign = workflowJob(finalizeWorkflow, "sign");
    const publish = workflowJob(finalizeWorkflow, "publish");
    const completion = workflowJob(finalizeWorkflow, "verify_completion");
    expect(finalizeWorkflow).toContain("apple-notarization-complete");
    expect(finalizeWorkflow).toContain("workflow_dispatch");
    expect(resolve).toContain("scripts/verify-release-source.mjs");
    expect(resolve).toContain(".github/workflows/release.yml");
    expect(resolve).toContain("refs/heads/main");
    expect(resolve).toContain("prerelease");
    expect(resolve).toContain("waiting for completion");
    expect(resolve).toContain("secrets.PUBLIC_RELEASE_READ_TOKEN");
    expect(resolve).toContain('preview_json="$(GH_TOKEN="$PUBLIC_RELEASE_READ_TOKEN" gh api \\');
    expect(resolve).toContain('"repos/$PUBLIC_RELEASE_REPOSITORY/releases/tags/$preview_tag")"');
    expect(resolve).not.toContain("https://api.github.com/repos/$PUBLIC_RELEASE_REPOSITORY");
    expect(finalize).toContain("scripts/macos-notarization-state.mjs verify");
    expect(finalize).toContain("APPLE_TEAM_ID");
    expect(finalize).toContain("Accepted");
    expect(finalize).not.toContain("secrets.PUBLIC_RELEASE_TOKEN");
    expect(finalize).not.toContain("secrets.PUBLIC_RELEASE_READ_TOKEN");
    expect(packageJob).toContain("ref: ${{ github.sha }}");
    expect(packageJob).toContain("ref: ${{ needs.resolve.outputs.commit }}");
    expect(packageJob).toContain("path: release-source");
    expect(packageJob).toContain("--changelog release-source/CHANGELOG.md");
    expect(finalizeWorkflow).not.toContain("recover_updaters");

    const signatureRecovery = workflowJob(finalizeWorkflow, "recover_updater_signatures");
    expect(signatureRecovery).toContain("ref: ${{ github.sha }}");
    expect(signatureRecovery).toContain("Download exact source updater package");
    expect(signatureRecovery).toContain("pnpm tauri signer sign");
    expect(signatureRecovery).toContain("secrets.TAURI_SIGNING_PRIVATE_KEY");
    expect(signatureRecovery).not.toContain("tauri-action");
    expect(packageJob).not.toContain("secrets.TAURI_SIGNING_PRIVATE_KEY");
    expect(sign).toContain("always()");
    expect(sign).toContain("!cancelled()");
    expect(sign).toContain("needs.package.result == 'success'");
    expect(publish).toContain("always()");
    expect(publish).toContain("!cancelled()");
    expect(publish).toContain("needs.sign.result == 'success'");
    expect(publish).toContain("Verify staged public draft release");
    expect(publish).toContain("--json databaseId");
    expect(publish).toContain('releases/$release_id');
    expect(publish).not.toContain('releases/tags/$RELEASE_TAG');
    expect(publish).toContain("expected-release-assets");
    expect(publish).toContain("staged-release-assets");
    expect(completion).toContain("always() && !cancelled()");
    expect(completion).toContain("needs.recover_updater_signatures.result");
    expect(completion).toContain('test "$SIGN_RESULT" = "success"');
    expect(completion).toContain('test "$PUBLISH_RESULT" = "success"');
  });

  it("fails closed when a release stage silently skips its required terminal job", () => {
    const sign = workflowJob(releaseWorkflow, "sign");
    const publish = workflowJob(releaseWorkflow, "publish");
    const completion = workflowJob(releaseWorkflow, "verify_completion");
    expect(sign).toContain("always() && !cancelled()");
    expect(sign).toContain("needs.package.result == 'success'");
    expect(publish).toContain("always() && !cancelled()");
    expect(publish).toContain("needs.sign.result == 'success'");
    expect(publish).toContain("Verify staged public draft release");
    expect(publish).toContain("--json databaseId");
    expect(publish).toContain('releases/$release_id');
    expect(publish).not.toContain('releases/tags/$GITHUB_REF_NAME');
    expect(completion).toContain("always() && !cancelled()");
    expect(completion).toContain("USE_HOSTED_MACOS");
    expect(completion).toContain('test "$PREVIEW_RESULT" = "success"');
    expect(completion).toContain('test "$PUBLISH_RESULT" = "success"');
  });

  it("matches the updater manifest to Tauri v2 uncompressed updater artifacts", () => {
    expect(tauriConfig.bundle.createUpdaterArtifacts).toBe(true);
    expect(updaterManifestGenerator).toContain("packagePattern: /\\.AppImage$/i");
    expect(updaterManifestGenerator).toContain("packagePattern: /-setup\\.exe$/i");
    expect(updaterManifestGenerator).not.toContain("AppImage.tar.gz");
    expect(updaterManifestGenerator).not.toContain("nsis.zip");
  });

  it("describes the platform trust boundary accurately in generated release notes", () => {
    expect(releaseNotesRenderer).toContain("Hardened Runtime");
    expect(releaseNotesRenderer).toContain("Developer ID Application");
    expect(releaseNotesRenderer).toContain("DMG 完成 Apple 公证");
    expect(releaseNotesRenderer).toContain("Windows 与 Linux");
  });

  it("gates production entries and every platform package before publishing", () => {
    const verify = workflowJob(releaseWorkflow, "verify");
    const build = workflowJob(releaseWorkflow, "build");
    const macOSBuild = workflowJob(releaseWorkflow, "build_macos_github");
    expect(verify).toContain("pnpm verify:web-bundle");
    expect(verify).toContain("pnpm test:surface-contracts");
    expect(verify).toContain("pnpm test:performance-contracts");
    expect(verify).toContain("pnpm verify:release-tools");
    expect(build).toContain("pnpm verify:web-bundle");
    expect(macOSBuild).toContain("scripts/verify-packaged-macos.sh");
    expect(build).toContain("scripts/verify-packaged-linux.sh");
    expect(build).toContain("scripts/verify-packaged-windows.ps1");
    expect(build).toContain("workflowArtifactNamePattern: ${{ matrix.artifact }}-[bundle]-[ext]");
    expect(build).toContain("Upload updater signature explicitly");
    expect(workflowJob(releaseWorkflow, "package")).toContain("generate-updater-manifest.mjs");
    expect(workflowJob(releaseWorkflow, "package")).toContain("flatten-release-artifacts.mjs");
    expect(workflowJob(releaseWorkflow, "package")).toContain("latest.json");
    expect(workflowJob(finalizeWorkflow, "package")).toContain("generate-updater-manifest.mjs");
    expect(workflowJob(finalizeWorkflow, "package")).toContain("latest.json");
  });
});

function workflowJob(workflow, name) {
  const heading = `  ${name}:\n`;
  const start = workflow.indexOf(heading);
  if (start < 0) throw new Error(`Workflow job not found: ${name}`);
  const bodyStart = start + heading.length;
  const nextJobOffset = workflow.slice(bodyStart).search(/^ {2}[a-z][a-z0-9_-]*:\n/m);
  const end = nextJobOffset < 0 ? workflow.length : bodyStart + nextJobOffset;
  return workflow.slice(start, end);
}

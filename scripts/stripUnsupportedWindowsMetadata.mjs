import fs from 'node:fs/promises';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import * as PELibrary from 'pe-library';
import * as ResEdit from 'resedit';

/**
 * Electron's upstream executable contains GitHub, Inc. metadata. The application
 * has no verified publisher or copyright value, so remove those inherited fields
 * before electron-builder writes the supported SUPRA branding and icon.
 *
 * @param {import('electron-builder').AfterPackContext} context
 */
export default async function stripUnsupportedWindowsMetadata(context) {
  if (context.electronPlatformName !== 'win32') return;

  const executablePath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.exe`,
  );
  const original = await fs.readFile(executablePath);
  const executable = PELibrary.NtExecutable.from(original, { ignoreCert: true });
  const resources = PELibrary.NtExecutableResource.from(executable);

  for (const versionInfo of ResEdit.Resource.VersionInfo.fromEntries(resources.entries)) {
    for (const language of versionInfo.getAllLanguagesForStringValues()) {
      versionInfo.removeStringValue(language, 'CompanyName');
      versionInfo.removeStringValue(language, 'LegalCopyright');
    }
    versionInfo.outputToResourceEntries(resources.entries);
  }

  resources.outputResource(executable);
  await fs.writeFile(executablePath, Buffer.from(executable.generate()));
}

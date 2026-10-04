/** Platform adapters return a texture URL understood by the renderer's loader. */
export interface AssetResolver {
  texture(file: string): string;
}

export type AssetManifest = Readonly<Record<string, string>>;

/**
 * Web builds resolve below their deployment base; desktop builds may supply a
 * file/asset protocol base or a manifest. A supplied manifest is complete: missing
 * entries fail before a texture loader can accidentally fall back to the network.
 */
export function createAssetResolver(
  baseURL: string,
  manifest?: AssetManifest,
): AssetResolver {
  const base = baseURL && !baseURL.endsWith("/") ? `${baseURL}/` : baseURL;
  return {
    texture(file) {
      if (!/^[a-zA-Z0-9_-][a-zA-Z0-9._/-]*$/.test(file)
        || file.split("/").some((part) => !part || part === "." || part === "..")) {
        throw new Error(`Invalid texture asset: ${file}`);
      }
      if (manifest !== undefined) {
        if (!Object.hasOwn(manifest, file) || !manifest[file]) {
          throw new Error(`Texture asset is missing from the manifest: ${file}`);
        }
        return manifest[file];
      }
      return `${base}textures/${file}`;
    },
  };
}

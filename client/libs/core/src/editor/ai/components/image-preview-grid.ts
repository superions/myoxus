/** Owns preview URLs only; the input's context remains the sole file-state owner. */
export class ImagePreviewUrls {
  // Distinct files can share every metadata field. Keep their resources separate.
  private readonly _urls = new Map<File, { url: string; revoked: boolean }>();

  readonly release = (file: File, url?: string) => {
    const resource = this._urls.get(file);
    // A detached image's late error must not revoke a newer URL for the same File.
    if (resource && !resource.revoked && (!url || resource.url === url)) {
      URL.revokeObjectURL(resource.url);
      resource.revoked = true;
    }
  };

  sync(files: readonly File[]) {
    for (const file of this._urls.keys()) {
      if (!files.includes(file)) {
        this.release(file);
        this._urls.delete(file);
      }
    }
    return files.map((file) => {
      let resource = this._urls.get(file);
      if (!resource) {
        resource = { url: URL.createObjectURL(file), revoked: false };
        this._urls.set(file, resource);
      }
      // Retain a failed resource until removal: rerenders must not retry it.
      return { file, url: resource.url };
    });
  }

  dispose() {
    for (const file of this._urls.keys()) this.release(file);
    this._urls.clear();
  }
}

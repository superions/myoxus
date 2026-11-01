const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 4000;

/**
 * Validate avatar uploads and reduce oversized images using the browser decoder.
 * Small files stay byte-identical (including animation and metadata). Resized
 * images contain oriented pixels, not the source EXIF orientation/metadata.
 */
export const validateAndReduceImage = async (file: File): Promise<File> => {
  const image = new Image();
  const url = URL.createObjectURL(file);
  let canvas: HTMLCanvasElement | undefined;
  try {
    image.src = url;
    await image.decode().catch(() => {
      throw new Error("Image could not be decoded");
    });
    const { naturalWidth: width, naturalHeight: height } = image;
    if (!width || !height) throw new Error("Image could not be decoded");
    if (
      file.size <= MAX_IMAGE_BYTES &&
      Math.max(width, height) <= MAX_IMAGE_DIMENSION
    ) {
      return file;
    }

    canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image processing failed");
    const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(width, height));
    let targetWidth = Math.max(1, Math.round(width * scale));
    let targetHeight = Math.max(1, Math.round(height * scale));

    // PNG preserves transparency for formats without a browser encoder.
    const mime = ["image/jpeg", "image/webp"].includes(file.type)
      ? file.type
      : "image/png";
    for (;;) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(image, 0, 0, targetWidth, targetHeight);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas!.toBlob(
          (result) =>
            result
              ? resolve(result)
              : reject(new Error("Image processing failed")),
          mime,
          0.92,
        );
      });
      if (blob.size <= MAX_IMAGE_BYTES) {
        // Canvas may fall back to PNG; label the actual bytes, not the input.
        const name =
          blob.type === file.type
            ? file.name
            : `${file.name.replace(/\.[^.]*$/, "")}.png`;
        return new File([blob], name, {
          type: blob.type,
          lastModified: file.lastModified,
        });
      }
      if (targetWidth === 1 && targetHeight === 1) {
        throw new Error("Image processing failed");
      }
      // Strictly decrease dimensions until the byte budget is met, without
      // flattening alpha or repeatedly resampling a previously reduced image.
      targetWidth = Math.max(1, Math.floor(targetWidth * 0.75));
      targetHeight = Math.max(1, Math.floor(targetHeight * 0.75));
    }
  } finally {
    image.src = "";
    URL.revokeObjectURL(url);
    if (canvas) canvas.width = canvas.height = 0;
  }
};

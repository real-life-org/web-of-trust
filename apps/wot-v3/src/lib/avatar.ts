// The profile picture (Trust 6b, 6475): a chosen image file cropped to a centered square and scaled
// to AVATAR_SIZE px, as a WebP data URI (as the earlier Web of Trust app did it). Well inside the
// library's bounds (PROFILE_LIMITS: 1024 px, about 45 KB); the library still checks the header.
export const AVATAR_SIZE = 200

export async function avatarFromFile(file: Blob, size = AVATAR_SIZE): Promise<string> {
  const bitmap = await createImageBitmap(file)
  try {
    const side = Math.min(bitmap.width, bitmap.height)
    const sx = (bitmap.width - side) / 2
    const sy = (bitmap.height - side) / 2
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas')
    ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size)
    const uri = canvas.toDataURL('image/webp', 0.8)
    // a browser without WebP encoding answers with PNG, which the profile does not take: JPEG then
    return uri.startsWith('data:image/webp') ? uri : canvas.toDataURL('image/jpeg', 0.85)
  } finally {
    bitmap.close()
  }
}

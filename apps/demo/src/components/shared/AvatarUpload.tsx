import { useRef } from 'react'
import { Camera, X } from 'lucide-react'
import { Avatar } from './Avatar'
import { useLanguage } from '../../i18n'


interface AvatarUploadProps {
  name?: string
  avatar: string | undefined
  onAvatarChange: (base64: string | undefined) => void
}

function resizeImage(file: File, maxSize: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)

    img.onload = () => {
      URL.revokeObjectURL(url)

      const canvas = document.createElement('canvas')
      canvas.width = maxSize
      canvas.height = maxSize

      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('Canvas not supported'))
        return
      }

      // Crop to square from center
      const srcSize = Math.min(img.width, img.height)
      const srcX = (img.width - srcSize) / 2
      const srcY = (img.height - srcSize) / 2

      ctx.drawImage(img, srcX, srcY, srcSize, srcSize, 0, 0, maxSize, maxSize)

      resolve(canvas.toDataURL('image/webp', 0.8))
    }

    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Failed to load image'))
    }

    img.src = url
  })
}

export function AvatarUpload({ name, avatar, onAvatarChange }: AvatarUploadProps) {
  const { t } = useLanguage()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (!file.type.startsWith('image/')) return

    try {
      const base64 = await resizeImage(file, 200)
      onAvatarChange(base64)
    } catch (err) {
      console.error('Failed to process image:', err)
    }

    // Reset input so same file can be selected again
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  return (
    <div className="flex flex-col items-center space-y-2">
      <div className="relative group">
        <Avatar name={name} avatar={avatar} size="lg" />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="absolute inset-0 rounded-full bg-black/0 group-hover:bg-black/30 flex items-center justify-center transition-colors cursor-pointer"
          aria-label={t.avatarUpload.chooseImage}
        >
          <Camera className="w-6 h-6 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
        </button>
        {avatar && (
          <button
            type="button"
            onClick={() => onAvatarChange(undefined)}
            className="absolute -top-1 -right-1 w-7 h-7 bg-destructive text-white rounded-full flex items-center justify-center hover:bg-destructive transition-colors"
            aria-label={t.avatarUpload.removeImage}
          >
            <X size={14} />
          </button>
        )}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileSelect}
        className="hidden"
      />
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        className="text-xs text-primary-600 hover:text-primary-700 transition-colors"
      >
        {avatar ? t.avatarUpload.changeImage : t.avatarUpload.uploadImage}
      </button>
    </div>
  )
}

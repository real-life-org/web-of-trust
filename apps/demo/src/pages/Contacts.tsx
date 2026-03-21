import { Link } from 'react-router-dom'
import { UserPlus } from 'lucide-react'
import { ContactList } from '../components'
import { useLanguage } from '../i18n'

export function Contacts() {
  const { t } = useLanguage()

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">{t.contacts.title}</h1>
        <Link
          to="/verify"
          className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white text-sm font-medium rounded-lg hover:bg-primary-700 transition-colors"
        >
          <UserPlus size={16} />
          {t.contacts.verifyButton}
        </Link>
      </div>
      <ContactList />
    </div>
  )
}

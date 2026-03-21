import Header from '../components/Header'
import Footer from '../components/Footer'
import SemanticNetwork from '../components/SemanticNetwork'

export default function NetworkPage() {
  return (
    <div className="h-screen overflow-y-auto snap-y snap-mandatory">
      <SemanticNetwork />
    </div>
  )
}

import { useEffect } from 'react'
import { Routes, Route, useLocation } from 'react-router-dom'
import LandingPage from './pages/LandingPage'
import BlogList from './pages/BlogList'
import BlogPost from './pages/BlogPost'
import ArchitecturePage from './pages/ArchitecturePage'
import NetworkPage from './pages/NetworkPage'

function ScrollToTop() {
  const { pathname, hash } = useLocation()
  useEffect(() => {
    if (hash) {
      const el = document.querySelector(hash)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth' })
        return
      }
    }
    window.scrollTo(0, 0)
  }, [pathname, hash])
  return null
}

function App() {
  return (
    <>
      <ScrollToTop />
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/architecture" element={<ArchitecturePage />} />
        <Route path="/netzwerk" element={<NetworkPage />} />
        <Route path="/blog" element={<BlogList />} />
        <Route path="/blog/:slug" element={<BlogPost />} />
      </Routes>
    </>
  )
}

export default App

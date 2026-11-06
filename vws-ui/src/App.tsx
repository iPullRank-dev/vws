
import { BrowserRouter, HashRouter, Routes, Route } from 'react-router-dom';
import Home from './pages/Home';
import AnalysisWorkspace from './pages/AnalysisWorkspace';
import LiveStatus from './pages/LiveStatus';
import './index.css';

// The packaged app loads index.html from disk (file://), where only hash routes
// survive a reload; the dev server keeps normal paths.
const Router = window.location.protocol === 'file:' ? HashRouter : BrowserRouter;

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/project/:projectId" element={<AnalysisWorkspace />} />
        <Route path="/project/:projectId/crawling" element={<LiveStatus />} />
      </Routes>
    </Router>
  );
}

export default App;

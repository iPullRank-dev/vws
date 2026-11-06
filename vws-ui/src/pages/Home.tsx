import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { Link, useNavigate } from 'react-router-dom';
import { PlusCircle, Search, Activity, Loader2, Trash2, RefreshCw } from 'lucide-react';
import { API_BASE } from '../config';
import { useToast } from '../hooks/useToast';
import './Home.css';
import VectorSourcePicker, { DEFAULT_VECTOR_SOURCE, isVectorSourceValid } from '../components/VectorSourcePicker';
import type { VectorSourceValue } from '../components/VectorSourcePicker';
import '../components/act.css';

// Mock data typed for the dashboard
interface Project {
  id: number;
  name: string;
  domain: string;
  crawldate: string;
  total_pages: number;
  focus_score: number;
}

// Empty array by default
const MOCK_PROJECTS: Project[] = [];

export default function Home() {
  const navigate = useNavigate();
  const { addToast, ToastContainer } = useToast();
  const [projects, setProjects] = useState<Project[]>(MOCK_PROJECTS);
  const [search, setSearch] = useState("");
  const [showModal, setShowModal] = useState(false);
  
  useEffect(() => {
    axios.get(`${API_BASE}/api/projects`)
      .then(res => {
        setProjects(res.data.projects);
      })
      .catch(err => console.error("Could not fetch projects", err));
  }, []);
  
  // Form State
  const [projectName, setProjectName] = useState("");
  const [crawlMode, setCrawlMode] = useState("url");
  const [targetUrls, setTargetUrls] = useState("");
  const [maxUrls, setMaxUrls] = useState(100);
  const [concurrency, setConcurrency] = useState(5);
  
  // CSV Upload State
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [vectorSource, setVectorSource] = useState<VectorSourceValue>(DEFAULT_VECTOR_SOURCE);
  
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setCsvFile(e.target.files[0]);
    }
  };

  const handleStartCrawl = async () => {
    if (!projectName) return;
    setIsSubmitting(true);
    try {
      if (crawlMode === 'csv') {
        if (!csvFile) {
          addToast("Please select a file to upload.", 'error');
          setIsSubmitting(false);
          return;
        }
        const formData = new FormData();
        if (!isVectorSourceValid(vectorSource)) {
          addToast("Tell VWS which model produced the CSV vectors (or choose to re-embed locally).", 'error');
          setIsSubmitting(false);
          return;
        }
        formData.append("name", projectName);
        formData.append("vector_mode", vectorSource.mode);
        formData.append("vector_column", vectorSource.mode === 'csv' ? vectorSource.column : "");
        formData.append("vector_model", vectorSource.mode === 'csv' ? vectorSource.model : "");
        formData.append("fetch_missing", String(vectorSource.fetchMissing));
        formData.append("file", csvFile);
        
        const response = await axios.post(`${API_BASE}/api/projects/upload-csv-init`, formData);
        const serverProj = response.data.data;
        navigate(`/project/${serverProj.id}`);
      } else {
        if (!targetUrls) return;
        const response = await axios.post(`${API_BASE}/api/projects`, {
          name: projectName,
          crawl_mode: crawlMode,
          start_urls: targetUrls,
          crawler_type: "playwright",
          max_urls: Number(maxUrls),
          concurrency: Number(concurrency)
        });
        const serverProj = response.data.data;
        navigate(`/project/${serverProj.id}/crawling`);
      }
    } catch (err) {
      console.error(err);
      addToast("Failed to start crawl.", 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteProject = async (e: React.MouseEvent, id: number) => {
    e.preventDefault();
    e.stopPropagation();
    if (!window.confirm("Are you sure you want to delete this project and all its embeddings?")) return;
    
    try {
      await axios.delete(`${API_BASE}/api/projects/${id}`);
      setProjects(prev => prev.filter(p => p.id !== id));
    } catch (err) {
      console.error(err);
      addToast("Failed to delete project.", 'error');
    }
  };

  const handleRecompute = async (e: React.MouseEvent, id: number) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const res = await axios.post(`${API_BASE}/api/projects/${id}/recompute`);
      setProjects(prev => prev.map(p => {
        if (p.id === id) {
          return {
            ...p,
            total_pages: res.data.total_pages,
            focus_score: res.data.focus_score
          };
        }
        return p;
      }));
    } catch (err) {
      console.error(err);
      addToast("Failed to recompute statistics.", 'error');
    }
  };

  const filtered = projects.filter(p => p.name.toLowerCase().includes(search.toLowerCase()) || p.domain.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="home-container">
      <header className="home-header">
        <div className="header-left">
          <h1>VWS Analytics</h1>
          <p className="subtitle">Vector Embeddings Dashboard for SEO</p>
        </div>
        <div className="header-right">
          <div className="search-bar">
            <Search size={18} />
            <input 
              type="text" 
              placeholder="Filter projects..." 
              value={search} 
              onChange={e => setSearch(e.target.value)} 
            />
          </div>
          <button className="btn-primary" onClick={() => setShowModal(true)}>
            <PlusCircle size={18} />
            New Project
          </button>
        </div>
      </header>

      <main className="project-grid">
        {filtered.length === 0 && search === "" && (
          <div className="empty-state">
            <div className="empty-state-icon">🔍</div>
            <h2>No Projects Yet</h2>
            <p>Get started by crawling a website or uploading a Screaming Frog CSV export to analyze your site's content topology.</p>
            <button className="btn-primary" onClick={() => setShowModal(true)} style={{ margin: '1.5rem auto 0', padding: '0.8rem 2rem', fontSize: '1rem' }}>
              <PlusCircle size={20} />
              Create Your First Project
            </button>
          </div>
        )}
        {filtered.map(proj => (
          <Link to={`/project/${proj.id}`} key={proj.id} className="project-card">
            <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <h3>{proj.name}</h3>
                <span className="domain">{proj.domain}</span>
              </div>
              <button 
                className="delete-button" 
                onClick={(e) => handleDeleteProject(e, proj.id)}
                style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', opacity: 0.7 }}
                onMouseOver={(e) => e.currentTarget.style.opacity = '1'}
                onMouseOut={(e) => e.currentTarget.style.opacity = '0.7'}
                title="Delete Project"
              >
                <Trash2 size={16} />
              </button>
            </div>
            <div className="card-metrics">
              <div className="metric">
                <span className="label">Focus Score</span>
                <span className={`value ${proj.focus_score > 0.8 ? 'good' : proj.focus_score > 0.6 ? 'warn' : 'bad'}`}>
                  {(proj.focus_score * 100).toFixed(0)}%
                </span>
                <span className="score-interpretation" style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                  {proj.focus_score > 0.8 ? 'Tight topical focus' : proj.focus_score > 0.6 ? 'Moderate — some drift' : 'Fragmented content'}
                </span>
              </div>
              <div className="metric">
                <span className="label">Pages</span>
                <span className="value">{proj.total_pages}</span>
              </div>
            </div>
            <div className="card-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Activity size={14} />
                <span>Last crawled: {proj.crawldate}</span>
              </div>
              <button 
                onClick={(e) => handleRecompute(e, proj.id)} 
                title="Recompute Stats"
                className="delete-button"
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', opacity: 0.7 }}
                onMouseOver={(e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.color = 'var(--accent)'; }}
                onMouseOut={(e) => { e.currentTarget.style.opacity = '0.7'; e.currentTarget.style.color = 'var(--text-muted)'; }}
              >
                <RefreshCw size={14} />
              </button>
            </div>
          </Link>
        ))}
      </main>

      {/* Modal - Updated for Crawl Modes */}
      {showModal && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>Create New Project</h2>
            <div className="form-group">
              <label>Project Name</label>
              <input type="text" placeholder="e.g. My Website" value={projectName} onChange={e => setProjectName(e.target.value)} />
            </div>
            <div className="form-group">
              <label>Crawl Mode</label>
              <select 
                value={crawlMode} onChange={e => setCrawlMode(e.target.value)}
                style={{ width: '100%', padding: '0.75rem', borderRadius: '6px', background: 'var(--bg-dark)', border: '1px solid var(--border)', color: 'white', outline: 'none' }}
              >
                <option value="url">Single URL (Spider)</option>
                <option value="list">URL List</option>
                <option value="sitemap">XML Sitemap or Index</option>
                <option value="csv">Screaming Frog CSV Upload</option>
              </select>
            </div>
            
            {crawlMode === 'csv' ? (
              <div className="form-group">
                 <label>Upload Dataset (.csv)</label>
                 <input type="file" accept=".csv" onChange={handleFileChange} />
                 <VectorSourcePicker file={csvFile} value={vectorSource} onChange={setVectorSource} />
              </div>
            ) : (
              <>
                <div className="form-group">
                  <label>Target URL(s) or Sitemap Link</label>
                  <textarea 
                    placeholder="https://...&#10;For List Mode, enter one URL per line." 
                    rows={3} 
                    value={targetUrls} onChange={e => setTargetUrls(e.target.value)}
                    style={{ width: '100%', padding: '0.75rem', borderRadius: '6px', background: 'var(--bg-dark)', border: '1px solid var(--border)', color: 'white', resize: 'vertical', outline: 'none', boxSizing: 'border-box' }}
                  />
                </div>
                <div className="form-group" style={{ display: 'flex', gap: '1rem' }}>
                  <div style={{ flex: 1 }}>
                    <label>Max URLs</label>
                    <input type="number" value={maxUrls} onChange={e => setMaxUrls(e.target.value as any)} style={{ width: '100%' }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label>Concurrency</label>
                    <input type="number" min="1" max="50" value={concurrency} onChange={e => setConcurrency(e.target.value as any)} style={{ width: '100%' }} />
                  </div>
                </div>
              </>
            )}
            
            <div className="form-actions">
              <button className="btn-secondary" onClick={() => setShowModal(false)} disabled={isSubmitting}>Cancel</button>
              <button className="btn-primary" onClick={handleStartCrawl} disabled={isSubmitting || (crawlMode === 'csv' && (!csvFile || !isVectorSourceValid(vectorSource)))}>
                {isSubmitting ? <Loader2 className="spinner" size={18} /> : "Start Crawl"}
              </button>
            </div>
          </div>
        </div>
      )}
      <ToastContainer />
    </div>
  );
}

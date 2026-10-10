import { FolderPlus, RefreshCw, Trash2 } from 'lucide-react'
import { useEffect } from 'react'
import { useApp } from '../store.ts'

export function ProjectsView() {
  const { projects, loadProjects, addProject, removeProject, rescanProject, setView } = useApp()
  useEffect(() => { void loadProjects() }, [loadProjects])
  if (!window.jarvis) return <div className="page"><h1>Projetos</h1><p className="dim">Disponível só no aplicativo desktop.</p></div>
  return (
    <div className="page">
      <h1>Projetos</h1>
      <p className="dim lead">Cada pasta autorizada vira uma rede própria na cena neural: pastas, arquivos e as importações entre eles. O JARVIS só lê; nada é alterado, e links simbólicos nunca são seguidos para fora da pasta.</p>
      <div className="actions"><button className="btn primary" onClick={() => void addProject()}><FolderPlus size={14} /> Autorizar uma pasta</button></div>
      <ul className="stack">
        {projects.length === 0 && <li className="dim">Nenhuma pasta autorizada ainda.</li>}
        {projects.map((p) => {
          const files = p.nodes.filter((n) => n.kind !== 'dir').length
          const links = p.edges.filter((e) => e[2] === 'import').length
          return (
            <li key={p.root} className="panel row-panel">
              <div className="grow">
                <h2>{p.name}</h2>
                <p className="dim small">{p.root}</p>
                <p className="dim small">{files} arquivos · {p.nodes.length - files} pastas · {links} importações{p.truncated ? ' · limitado a 700 itens' : ''}</p>
                {p.git && <p className="dim small">git: {p.git.branch ?? '?'}{p.git.remote ? ` · ${p.git.remote}` : ''}</p>}
                <p className="small">{p.nodes.filter((n) => n.kind === 'key').slice(0, 8).map((n) => n.path.split('/').pop()).join(' · ')}</p>
              </div>
              <button className="btn" onClick={() => setView('home')}>Ver na rede</button>
              <button className="icon-btn" aria-label={`Reescanear ${p.name}`} onClick={() => void rescanProject(p.root)}><RefreshCw size={15} /></button>
              <button className="icon-btn" aria-label={`Remover ${p.name}`} onClick={() => confirm(`Remover o acesso a "${p.name}"? A pasta em si não é tocada.`) && void removeProject(p.root)}><Trash2 size={15} /></button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

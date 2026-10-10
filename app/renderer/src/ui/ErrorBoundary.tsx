import { Component, type ReactNode } from 'react'

/** A render error (bad bridge payload, WebGL failure) must not blank the whole window. */
export class ErrorBoundary extends Component<{ children: ReactNode; label?: string }, { error: string | null }> {
  state = { error: null as string | null }
  static getDerivedStateFromError(e: unknown) { return { error: e instanceof Error ? e.message : String(e) } }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="page" role="alert">
        <h1>Algo falhou{this.props.label ? ` em ${this.props.label}` : ''}</h1>
        <p className="dim">{this.state.error}</p>
        <button className="btn" onClick={() => this.setState({ error: null })}>Tentar de novo</button>
      </div>
    )
  }
}

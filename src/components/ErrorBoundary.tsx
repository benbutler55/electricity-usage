import { Component, type ReactNode } from 'react'

interface Props { children: ReactNode }
interface State { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen flex items-center justify-center p-8">
          <div className="bg-slate-800 border border-red-800 rounded-xl p-6 max-w-lg w-full">
            <h2 className="text-red-400 font-semibold mb-2">Something went wrong</h2>
            <p className="text-slate-400 text-sm font-mono break-all">{this.state.error.message}</p>
            <button
              className="mt-4 text-xs text-slate-500 underline"
              onClick={() => this.setState({ error: null })}
            >
              Try again
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

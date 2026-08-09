// Garde-fou de rendu : un composant qui jette pendant le render démonte tout l'arbre React 19
// → écran noir. Cette barrière affiche l'erreur à l'écran (au lieu du noir) pour diagnostiquer.
import { Component, type ReactNode, type ErrorInfo } from "react";
import i18n from "@/i18n";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
  stack: string;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: "" };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[NetsuRush] crash de rendu :", error, info.componentStack);
    this.setState({ stack: info.componentStack ?? "" });
  }

  render() {
    const { error, stack } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex h-screen flex-col gap-3 overflow-auto bg-background p-6 text-sm text-foreground">
        <h1 className="text-base font-semibold text-destructive">{i18n.t("shell:errorBoundary.title")}</h1>
        <pre className="whitespace-pre-wrap rounded-md bg-card p-3 text-xs text-muted-foreground">
          {String(error.stack || error)}
        </pre>
        {stack && (
          <pre className="whitespace-pre-wrap rounded-md bg-card p-3 text-xs text-muted-foreground">{stack}</pre>
        )}
        <button
          type="button"
          onClick={() => location.reload()}
          className="self-start rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {i18n.t("shell:errorBoundary.reload")}
        </button>
      </div>
    );
  }
}

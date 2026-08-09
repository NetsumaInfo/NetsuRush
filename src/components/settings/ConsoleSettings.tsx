import { ConsolePanel } from "./console/ConsolePanel";
import { BugReportForm } from "./console/BugReportForm";

// Paramètres › Console : terminal log (copier / exporter / vider) + formulaire de rapport de bug
// (envoi au webhook Discord avec le journal joint). Pour le debug et les bêta-testeurs.
export function ConsoleSettings() {
  return (
    <div>
      <ConsolePanel />
      <BugReportForm />
    </div>
  );
}

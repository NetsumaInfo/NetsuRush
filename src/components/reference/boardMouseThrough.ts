// Fenêtre TRANSPARENTE À LA SOURIS : clics, molette et survol vont à l'application du dessous.
// La sortie ne peut pas être un clic (il n'arrive plus) : c'est le retour du FOCUS (Alt+Tab, barre
// des tâches), seul geste que l'OS route encore jusqu'ici.

import { nr } from "@/lib/bridge";
import { IS_DETACHED_WINDOW } from "@/lib/windowKind";
import { useApp } from "@/store";
import { useBoard } from "./useReferenceBoard";

// Une fenêtre traversante qui passe derrière l'application du dessous ne sert à rien : le premier
// clic la ferait disparaître. Elle reste donc au-dessus le temps du mode, l'épingle de la barre de
// titre le MONTRE (`onTopHold`), et l'état d'origine revient en sortant — sauf si l'épingle a été
// posée entre-temps. Une fenêtre détachée est déjà au-dessus par construction.

// Bascule l'état ET la fenêtre. SOURCE UNIQUE (barre d'outils, garde-fou de focus, démontage) :
// une interface qui annonce « souris active » sur une fenêtre sourde est inutilisable.
export function setMouseThrough(on: boolean): void {
  if (useBoard.getState().mouseThrough === on) return;
  useBoard.getState().setMouseThrough(on);
  nr.setMouseTransparent(on);
  if (IS_DETACHED_WINDOW) return;
  const app = useApp.getState();
  app.setOnTopHold(on);
  if (on) {
    if (!app.pinned) nr.setAlwaysOnTop(true);
  } else if (!app.pinned) {
    // L'épingle posée pendant le mode gagne : elle, elle est un choix.
    nr.setAlwaysOnTop(false);
  }
}

// Bascule DEMANDÉE : la première fois, elle passe par l'avertissement, qui donne la sortie du mode.
// Source unique de la barre d'outils et du raccourci.
export function askMouseThrough(): void {
  const st = useBoard.getState();
  if (st.mouseThrough) { setMouseThrough(false); return; }
  if (st.prefs.mouseThroughWarned) { setMouseThrough(true); return; }
  st.setMouseThroughAsk(true);
}

// Garde-fou : le focus retrouvé rend la souris. Appelé au montage du board ; le désabonnement la
// rend aussi (une fenêtre démontée en mode transparent resterait sourde).
export function watchMouseThroughExit(): () => void {
  const onFocus = () => setMouseThrough(false);
  window.addEventListener("focus", onFocus);
  return () => {
    window.removeEventListener("focus", onFocus);
    setMouseThrough(false);
  };
}

import { useEffect, useRef, useState } from "react";

// Un droit ACCORDÉ de façon asynchrone (créneau de lecture, tour de montage, délai de stabilisation),
// qui retombe SANS re-rendu dès que la demande n'a plus lieu d'être.
//
// La version d'avant tenait ce drapeau dans un `useState` remis à false dans le cleanup de l'effet.
// Or ce cleanup tourne dans le commit qui vient de rendre `active` faux : le rendu avait déjà conclu
// sans le droit, et ce `setState` ne servait qu'à déclencher un commit de plus. À l'échelle d'une
// grille qui défile, chaque carte en faisait deux ou trois par transition — assez de commits
// enchaînés depuis des effets pour que React (en dev) signale « Maximum update depth exceeded »,
// et surtout autant de travail de rendu pris sur le thread qui fait avancer le défilement.
//
// Ici le droit vit dans une ref : l'octroi la lève et force UN rendu ; la perte la baisse dans le
// cleanup, sans rendu, puisque `active` faux suffit déjà au rendu courant. Le résultat rendu est
// `active && accordé` — jamais vrai pour une demande qui n'existe plus.
//
// `request` reçoit la fonction d'octroi et rend celle d'abandon (ou rien). Elle est relue à chaque
// appel : la relancer parce que sa closure a changé annulerait la demande en cours.
export function useGranted(
  active: boolean,
  request: (grant: () => void) => (() => void) | void,
  deps: readonly unknown[] = [],
): boolean {
  const granted = useRef(false);
  const [, bump] = useState(0);
  const requestRef = useRef(request);
  requestRef.current = request;
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const release = requestRef.current(() => {
      if (!alive || granted.current) return;
      granted.current = true;
      bump((n) => n + 1);
    });
    return () => {
      alive = false;
      granted.current = false;
      release?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, ...deps]);
  return active && granted.current;
}

import { Scissors, PenLine, Search, Wand2, Images, ArrowLeftRight, AudioLines, MessageSquare, Gauge, NotebookPen } from "lucide-react";
import type { ModuleId } from "@/lib/modules";

// Navigation latérale — partagée avec App (lookup du libellé de l'onglet actif).
export const NAV: { id: ModuleId; label: string; labelKey: string; icon: typeof Scissors }[] = [
  { id: "derush", label: "NetsuCut", labelKey: "nav.derush", icon: Scissors },
  { id: "search", label: "NetsuSearch", labelKey: "nav.search", icon: Search },
  { id: "reference", label: "NetsuBoard", labelKey: "nav.reference", icon: Images },
  { id: "notebook", label: "NetsuBook", labelKey: "nav.notebook", icon: NotebookPen },
  { id: "script", label: "NetsuDraft", labelKey: "nav.script", icon: PenLine },
  { id: "upscale", label: "NetsuLab", labelKey: "nav.upscale", icon: Wand2 },
  { id: "voice", label: "NetsuTalk", labelKey: "nav.voice", icon: AudioLines },
  { id: "chat", label: "NetsuPilot", labelKey: "nav.chat", icon: MessageSquare },
  { id: "optimisation", label: "NetsuBoost", labelKey: "nav.optimisation", icon: Gauge },
  { id: "transfer", label: "NetsuBridge", labelKey: "nav.transfer", icon: ArrowLeftRight },
];

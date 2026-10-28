import type { ComponentType } from "react";

import { NetsuIcon } from "@/components/ui/netsu-icon";

export type NavIcon = ComponentType<{ className?: string }>;

export const NavCutIcon: NavIcon = (props) => <NetsuIcon name="nav-netsucut" {...props} />;
export const NavSearchIcon: NavIcon = (props) => <NetsuIcon name="nav-netsusearch" {...props} />;
export const NavBookIcon: NavIcon = (props) => <NetsuIcon name="nav-netsubook" {...props} />;
export const NavLabIcon: NavIcon = (props) => <NetsuIcon name="nav-netsulab" {...props} />;
export const NavPilotIcon: NavIcon = (props) => <NetsuIcon name="nav-netsupilot" {...props} />;
export const NavBoostIcon: NavIcon = (props) => <NetsuIcon name="nav-netsuboost" {...props} />;
export const NavBridgeIcon: NavIcon = (props) => <NetsuIcon name="nav-netsubridge" {...props} />;

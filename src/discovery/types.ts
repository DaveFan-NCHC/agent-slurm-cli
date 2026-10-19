export type DiscoveryTarget = "cluster" | "modules" | "associations" | "runtimes";

export interface RuntimeDiscovery {
  configured_path: string;
  available: boolean;
  executable: boolean;
  resolved_path?: string;
}

export interface AssociationDiscovery {
  account: string;
  partitions: string[];
  qos: string[];
  default_qos?: string;
}

export interface ReservationDiscovery {
  name: string;
  partitions: string[];
  accounts: string[];
  users: string[];
  state?: string;
  start_time?: string;
  end_time?: string;
  flags: string[];
}

export interface DiscoveryNodeInfo {
  node_name: string;
  partition: string;
  state: string;
  cpus: {
    total: number;
  };
  memory: {
    total_mib: number;
  };
  gres: string[];
  features: string[];
}

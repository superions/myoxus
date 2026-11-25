import { useNetwork } from "@myoxus/ui-facade";

export function useSystemOnline(): boolean {
  return useNetwork().online;
}

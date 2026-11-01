import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { useLiveData, useService } from "@myoxus/infra";
import { Tabs, TabsList, TabsTrigger } from "@myoxus/ui-facade";
import { useCallback } from "react";

interface Tab {
  to: string;
  label: string;
}

const tabs: Tab[] = [
  {
    to: "/all",
    label: "Docs",
  },
  {
    to: "/collection",
    label: "Collections",
  },
  {
    to: "/tag",
    label: "Tags",
  },
];

export const AllDocsTabs = () => {
  const workbench = useService(WorkbenchService).workbench;
  const location = useLiveData(workbench.location$);
  const activeTab = tabs.some((tab) => tab.to === location.pathname)
    ? location.pathname
    : null;
  const handleTabChange = useCallback(
    (nextValue: string) => {
      workbench.open(nextValue, {
        at: "active",
        replaceHistory: true,
        show: false,
      });
    },
    [workbench],
  );

  return (
    <Tabs value={activeTab} onValueChange={handleTabChange}>
      <TabsList variant="page">
        {tabs.map((tab) => {
          return (
            <TabsTrigger key={tab.to} value={tab.to} variant="page">
              {tab.label}
            </TabsTrigger>
          );
        })}
      </TabsList>
    </Tabs>
  );
};

import { MyoxusText, Stack } from "@myoxus/ui-facade";
import type { ReactNode } from "react";

export interface DocumentInfoSectionProps {
  title: ReactNode;
  children: ReactNode;
  testId?: string;
}

export function DocumentInfoSection({
  title,
  children,
  testId,
}: DocumentInfoSectionProps) {
  return (
    <Stack
      component="section"
      data-myoxus-ui-role="sidebar-section"
      data-testid={testId}
      gap="xs"
    >
      <MyoxusText
        component="em"
        data-myoxus-ui-role="sidebar-section-header"
        italic
        typographySlot="body"
      >
        {title}
      </MyoxusText>
      <Stack data-myoxus-ui-role="sidebar-section-body" gap="xs">
        {children}
      </Stack>
    </Stack>
  );
}

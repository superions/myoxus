import { MyoxusText, ShellBrandLogo, Stack } from "@myoxus/ui-facade";

export const ChatLoadingState = ({ title }: { title: string }) => {
  return (
    <Stack
      align="center"
      justify="center"
      gap="sm"
      h="100%"
      w="100%"
      data-myoxus-ui-role="chat-panel-loading"
    >
      <ShellBrandLogo compact slot="productMark" alt="Myoxus Product Mark" />
      <MyoxusText
        component="span"
        fallbackSlot="body-small"
        tone="secondary"
        typographySlot="body-small"
        data-myoxus-ui-role="chat-panel-loading-title"
      >
        {title}
      </MyoxusText>
    </Stack>
  );
};

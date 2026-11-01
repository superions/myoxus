import {
  Button,
  StructureTreeEmptySection as StructureTreeEmptySectionFrame,
  StructureTreeEmptySectionAction,
  StructureTreeEmptySectionIcon,
  StructureTreeEmptySectionMessage,
} from "@myoxus/ui-facade";
import {
  cloneElement,
  forwardRef,
  type HTMLAttributes,
  type JSX,
  type ReactElement,
  type Ref,
  type SVGAttributes,
  type SVGProps,
} from "react";

interface StructureTreeEmptySectionProps extends HTMLAttributes<HTMLDivElement> {
  icon:
    | ((props: SVGProps<SVGSVGElement>) => JSX.Element)
    | ReactElement<SVGAttributes<SVGElement>>;
  message: string;
  messageTestId?: string;
  actionText?: string;
  onActionClick?: () => void;
}

export const StructureTreeEmptySection = forwardRef(
  function StructureTreeEmptySection(
    {
      icon: Icon,
      message,
      messageTestId,
      actionText,
      children,
      className,
      onActionClick,
      ...attrs
    }: StructureTreeEmptySectionProps,
    ref: Ref<HTMLDivElement>,
  ) {
    const icon = typeof Icon === "function" ? <Icon /> : cloneElement(Icon);

    return (
      <StructureTreeEmptySectionFrame
        className={className}
        ref={ref}
        {...attrs}
      >
        <StructureTreeEmptySectionIcon>{icon}</StructureTreeEmptySectionIcon>
        <StructureTreeEmptySectionMessage data-testid={messageTestId}>
          {message}
        </StructureTreeEmptySectionMessage>
        {actionText ? (
          <StructureTreeEmptySectionAction>
            <Button
              data-myoxus-ui-role="button:compact"
              onClick={onActionClick}
            >
              {actionText}
            </Button>
          </StructureTreeEmptySectionAction>
        ) : null}
        {children}
      </StructureTreeEmptySectionFrame>
    );
  },
);

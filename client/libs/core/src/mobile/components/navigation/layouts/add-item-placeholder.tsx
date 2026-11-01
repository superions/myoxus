import { StructureTreeContext } from "@myoxus/core/components/structure-tree";
import { PlusIcon } from "@myoxus/icons/react";
import {
  StructureTreeContent,
  StructureTreeIconSlot,
  StructureTreeLabel,
  StructureTreeRow,
} from "@myoxus/ui-facade";
import { type HTMLAttributes, useContext } from "react";

export interface AddItemPlaceholderProps extends HTMLAttributes<HTMLDivElement> {
  onClick?: () => void;
  label?: string;
  icon?: React.ReactNode;
}

export const AddItemPlaceholder = ({
  onClick,
  label = "Add Item",
  icon = <PlusIcon />,
  className,
  ...attrs
}: AddItemPlaceholderProps) => {
  const context = useContext(StructureTreeContext);
  const level = context?.level ?? 0;

  return (
    <StructureTreeContent
      data-myoxus-ui-role="mobile-navigation-add-item-content"
      level={level}
      open
    >
      <StructureTreeRow
        onClick={onClick}
        className={className}
        data-placeholder="true"
        data-touch="true"
        data-myoxus-ui-role="mobile-navigation-add-item"
        label={<StructureTreeLabel>{label}</StructureTreeLabel>}
        leftSection={<StructureTreeIconSlot>{icon}</StructureTreeIconSlot>}
        {...attrs}
      />
    </StructureTreeContent>
  );
};

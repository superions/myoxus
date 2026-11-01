import { Button, type ButtonProps } from "@myoxus/ui-facade";

export const ActionButton = ({ size, ...props }: ButtonProps) => {
  return <Button size={size ?? "large"} {...props} />;
};

import {
  MOBILE_SEARCH_VIEW_TRANSITION_SCOPE,
  MobileSearchInput,
} from "@myoxus/ui-facade";
import { forwardRef, type InputHTMLAttributes } from "react";

export interface SearchInputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "onChange" | "onInput" | "size"
> {
  debounce?: number;
  onInput?: (value: string) => void;
}

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(
  function SearchInput(props, ref) {
    return <MobileSearchInput {...props} ref={ref} />;
  },
);
export const searchVTScope = MOBILE_SEARCH_VIEW_TRANSITION_SCOPE;

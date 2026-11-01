// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import {
  Table,
  TableBody,
  TableCell,
  TableRow,
  TableScrollContainer,
} from "./index";
import { MyoxusUIProvider } from "./provider";

describe("facade table", () => {
  afterEach(cleanup);

  test("constrains wide tables to a widget-owned horizontal scroll viewport", () => {
    render(
      <MyoxusUIProvider>
        <TableScrollContainer data-testid="table-scroll">
          <Table>
            <TableBody>
              <TableRow>
                <TableCell>Value</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </TableScrollContainer>
      </MyoxusUIProvider>,
    );

    const scrollContainer = screen.getByTestId("table-scroll");
    expect(scrollContainer.dataset.myoxusUiRole).toBe("table-scroll-container");
    expect(scrollContainer.style.minWidth).toMatch(/^0(?:rem)?$/);
    expect(scrollContainer.style.width).toBe("100%");
  });
});

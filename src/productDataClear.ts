import type { ProductDataCategory } from "./hooks/useProductDataPrivacy";

export type ProductDataClearScope = ProductDataCategory | "toolbox" | "preferences";
export type ProductDataClearResultStatus = "succeeded" | "failed" | "skipped";

export interface ProductDataClearResult {
  scope: ProductDataClearScope;
  status: ProductDataClearResultStatus;
}

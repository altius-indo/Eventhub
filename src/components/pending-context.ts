"use client";

import { createContext } from "react";

/** Lets SubmitButton show a pending state for forms submitted via startTransition. */
export const PendingContext = createContext(false);

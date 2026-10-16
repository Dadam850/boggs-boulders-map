import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-2xl text-lg font-extrabold tracking-tight transition active:translate-y-px disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-black/25",
  {
    variants: {
      variant: {
        default: "bg-orange-600 text-white shadow-[0_3px_0_#111]",
        dark: "bg-zinc-950 text-white shadow-[0_3px_0_#111]",
        light: "bg-white text-zinc-950 border-[3px] border-zinc-950 shadow-[0_3px_0_#111]",
      },
      size: {
        glove: "min-h-16 px-4 py-3",
        icon: "h-16 w-16 shrink-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "glove",
    },
  },
);

export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

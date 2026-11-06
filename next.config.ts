import type { NextConfig } from "next";

const config: NextConfig = {
  // better-sqlite3 is a native module, so Next must load it from node_modules instead of bundling it.
  serverExternalPackages: ["better-sqlite3", "imapflow", "mailparser", "nodemailer"],
  experimental: {
    // CSV uploads go through a server action. Raise the default 1 MB limit so big lists work.
    serverActions: { bodySizeLimit: "25mb" },
  },
};

export default config;

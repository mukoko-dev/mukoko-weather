/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    auth: import("./auth/session").AuthLike;
  }
}

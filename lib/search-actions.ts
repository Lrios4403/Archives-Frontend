"use server"

import { redirect } from "next/navigation"
import { searchHref } from "@/components/WarcSearch/actions"

export async function searchAction(formData: FormData) {
  const query = formData.get("q") as string
  if (query?.trim()) {
    redirect(searchHref(query))
  }
}

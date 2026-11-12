"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth/session";
import { formError, formField, type FormState } from "@/lib/form-error";
import { createArticle, deleteArticle, updateArticle } from "@/lib/kb";

function refresh(id?: string) {
  revalidatePath("/desk/kb");
  if (id) revalidatePath(`/desk/kb/${id}`);
  revalidatePath("/kb");
}

/** New article: a draft unless the agent pressed "Publish". The address (slug) comes from the title. */
export async function createArticleAction(_prev: FormState, formData: FormData): Promise<FormState> {
  try {
    const agent = await requireRole("agent");
    const created = await createArticle(agent, {
      title: formField(formData, "title"),
      body: formField(formData, "body"),
      status: formField(formData, "intent") === "publish" ? "published" : "draft",
    });
    refresh(created.id);
    redirect(`/desk/kb/${created.id}?saved=1`);
  } catch (err) {
    return { error: formError(err) };
  }
}

/** Save title and body; "publish" or "unpublish" also changes the status in the same write. */
export async function saveArticleAction(id: string, _prev: FormState, formData: FormData): Promise<FormState> {
  try {
    const agent = await requireRole("agent");
    const intent = formField(formData, "intent");
    const status = intent === "publish" ? "published" : intent === "unpublish" ? "draft" : undefined;
    await updateArticle(agent, id, { title: formField(formData, "title"), body: formField(formData, "body"), ...(status ? { status } : {}) });
    refresh(id);
    redirect(`/desk/kb/${id}?saved=1`);
  } catch (err) {
    return { error: formError(err) };
  }
}

export async function deleteArticleAction(id: string, _prev: FormState, formData: FormData): Promise<FormState> {
  void formData;
  try {
    const agent = await requireRole("agent");
    await deleteArticle(agent, id);
    refresh();
    redirect("/desk/kb?deleted=1");
  } catch (err) {
    return { error: formError(err) };
  }
}

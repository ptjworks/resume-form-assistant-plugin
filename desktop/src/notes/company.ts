// 「该公司心得」用到的纯计算：投递页数篇数，心得页按公司筛文件夹。
// 只依赖 note_index_cmd 返回的文件夹与心得，不读别的数据。

export interface CompanyFolder {
  id: string;
  applicationId: string | null;
  company: string | null;
  recycled: boolean;
}

export interface CompanyNote {
  folderId: string;
  recycled: boolean;
}

/** 公司名比较前去掉首尾空格；没有公司名当作空串。 */
export function normalizeCompany(company: string | null | undefined): string {
  return (company ?? "").trim();
}

/** 文件夹算这家公司的：必须已关联申请，且公司名（去首尾空格后）一样。没关联申请的文件夹不算。 */
export function folderBelongsToCompany(folder: CompanyFolder | undefined, company: string): boolean {
  const wanted = normalizeCompany(company);
  if (!folder || !wanted || !folder.applicationId) return false;
  return normalizeCompany(folder.company) === wanted;
}

/** 这家公司名下所有岗位的、没被回收的心得篇数（文件夹被回收的也不算）。 */
export function countCompanyNotes(
  index: { folders: CompanyFolder[]; notes: CompanyNote[] },
  company: string,
): number {
  const folders = new Map(index.folders.map((folder) => [folder.id, folder]));
  let count = 0;
  for (const note of index.notes) {
    if (note.recycled) continue;
    const folder = folders.get(note.folderId);
    if (!folder || folder.recycled) continue;
    if (folderBelongsToCompany(folder, company)) count += 1;
  }
  return count;
}

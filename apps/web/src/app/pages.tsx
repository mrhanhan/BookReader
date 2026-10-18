import { EmptyState } from '@bookr/ui';

/** Placeholder destinations until the bookshelf, trash and admin tasks land. */
export function BookshelfPage() {
  return (
    <section className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl text-ink">书架</h1>
        <p className="mt-1 text-sm text-muted">和家人共享的藏书都在这里。</p>
      </div>
      <EmptyState
        title="书架还是空的"
        description="上传第一本书之后，封面、阅读进度和分类都会陈列在这里。"
      />
    </section>
  );
}

export function TrashPage() {
  return (
    <section className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl text-ink">回收站</h1>
        <p className="mt-1 text-sm text-muted">删除的书籍会在这里保留一段时间。</p>
      </div>
      <EmptyState title="回收站是空的" description="目前没有被删除的书籍。" />
    </section>
  );
}

export function AdminPage() {
  return (
    <section className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl text-ink">管理</h1>
        <p className="mt-1 text-sm text-muted">成员、邀请码和存储用量的管理入口。</p>
      </div>
      <EmptyState title="管理功能即将上线" description="成员邀请与存储管理将在后续任务中开放。" />
    </section>
  );
}

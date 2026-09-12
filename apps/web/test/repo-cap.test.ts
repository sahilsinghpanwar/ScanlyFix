import { describe, expect, it } from 'vitest'
import { chooseConnectedRepo } from '@/lib/repo-cap.ts'

function repo(id: number) {
  return {
    githubId: id,
    owner: 'owner',
    name: `repo-${id}`,
    fullName: `owner/repo-${id}`,
    defaultBranch: 'main',
    private: false,
  }
}

describe('chooseConnectedRepo', () => {
  it('keeps the account’s existing connected repo when the fresh grant still includes it', () => {
    const granted = [repo(1), repo(2), repo(3)]
    const chosen = chooseConnectedRepo([repo(2)], granted)
    expect(chosen?.repo.githubId).toBe(2)
    expect(chosen?.keptExisting).toBe(true)
  })

  it('falls back to the first granted repo on a first-ever connect', () => {
    const granted = [repo(7), repo(8)]
    const chosen = chooseConnectedRepo([], granted)
    expect(chosen?.repo.githubId).toBe(7)
    expect(chosen?.keptExisting).toBe(false)
  })

  it('picks the first granted repo when the previously connected one is no longer granted', () => {
    const granted = [repo(4), repo(5)]
    const chosen = chooseConnectedRepo([repo(9)], granted)
    expect(chosen?.repo.githubId).toBe(4)
    expect(chosen?.keptExisting).toBe(false)
  })

  it('returns null when the grant carries no repositories', () => {
    expect(chooseConnectedRepo([], [])).toBeNull()
  })

  it('returns null on a fresh connect whose install selected nothing', () => {
    expect(chooseConnectedRepo([repo(1)], [])).toBeNull()
  })
})

import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core'
import { Router } from '@angular/router'
import { DATASHEETS } from '@nw-data/generated'
import { CharactersService, CharacterStore, GearsetsService, injectNwData, SkillTreesService } from '~/data'
import { TranslateService } from '~/i18n'
import { NwModule } from '~/nw'
import { ModalService } from '~/ui/layout'
import { LedgerCharacterNotFoundError } from './ledger-character'
import { applyLedgerImport, LedgerImportResult, ledgerGearset, readLedgerImport } from './ledger-import'
import { LedgerFormatError } from './ledger-parser'

@Component({
  selector: 'nwb-ledger-import',
  template: `
    <div class="card bg-base-200 w-full max-w-xs">
      <div class="card-body p-4 gap-3">
        <h3 class="card-title text-base">Import from capture</h3>
        <p class="text-sm opacity-75">
          Load a <code>ledger.bin</code> (or the capture zip) recorded with the nw_capture tool. Start the capture before
          you select your character, so the login snapshot is included.
        </p>
        <input
          type="file"
          class="file-input file-input-sm w-full"
          accept=".bin,.zip,application/octet-stream,application/zip"
          [disabled]="busy()"
          (change)="handleFile($event)"
        />
        @if (busy()) {
          <div class="flex flex-row items-center gap-2 text-sm">
            <span class="loading loading-spinner loading-sm"></span>
            Reading capture…
          </div>
        }
        @if (error()) {
          <div role="alert" class="alert alert-error alert-soft text-sm">{{ error() }}</div>
        }
        @if (result(); as it) {
          <div class="flex flex-col gap-1 text-sm">
            <div class="flex flex-row justify-between">
              <span class="opacity-75">Name</span>
              <span class="font-bold">{{ it.name || '-' }}</span>
            </div>
            <div class="flex flex-row justify-between">
              <span class="opacity-75">Level</span>
              <span class="font-bold">{{ it.level ?? '-' }}</span>
            </div>
            <div class="flex flex-row justify-between">
              <span class="opacity-75">Faction</span>
              <span class="font-bold capitalize">{{ it.faction || '-' }}</span>
            </div>
            <details class="collapse collapse-arrow bg-base-300 mt-1">
              <summary class="collapse-title min-h-0 py-2 text-sm">Weapon mastery ({{ it.weapons.length }})</summary>
              <div class="collapse-content">
                @for (row of it.weapons; track row.id) {
                  <div class="flex flex-row justify-between">
                    <span>{{ row.label | nwText }}</span>
                    <span>{{ row.value }}</span>
                  </div>
                }
              </div>
            </details>
            <details class="collapse collapse-arrow bg-base-300">
              <summary class="collapse-title min-h-0 py-2 text-sm">Tradeskills ({{ it.tradeskills.length }})</summary>
              <div class="collapse-content">
                @for (row of it.tradeskills; track row.id) {
                  <div class="flex flex-row justify-between">
                    <span>{{ row.label }}</span>
                    <span>{{ row.value }}</span>
                  </div>
                }
              </div>
            </details>
            <details class="collapse collapse-arrow bg-base-300">
              <summary class="collapse-title min-h-0 py-2 text-sm">Standing ({{ it.territories.length }})</summary>
              <div class="collapse-content">
                @for (row of it.territories; track row.id) {
                  <div class="flex flex-row justify-between">
                    <span>{{ row.label | nwText }}</span>
                    <span>{{ row.value }}</span>
                  </div>
                }
              </div>
            </details>
            <details class="collapse collapse-arrow bg-base-300">
              <summary class="collapse-title min-h-0 py-2 text-sm">Equipment ({{ it.equipment.length }})</summary>
              <div class="collapse-content">
                @for (row of it.equipment; track row.slot) {
                  <div class="flex flex-row justify-between gap-2">
                    <span class="truncate" [title]="row.itemId">{{ row.name | nwText }}</span>
                    <span>{{ row.gearScore }}</span>
                  </div>
                }
                @if (it.equipment.length) {
                  <div class="text-xs opacity-50 mt-1">Perks are not decoded yet, items show their default perks.</div>
                }
              </div>
            </details>
            <details class="collapse collapse-arrow bg-base-300">
              <summary class="collapse-title min-h-0 py-2 text-sm">Skill trees ({{ it.skillTrees.length }})</summary>
              <div class="collapse-content">
                @for (row of it.skillTrees; track row.weapon) {
                  <div class="flex flex-row justify-between gap-2">
                    <span>{{ row.label | nwText }}</span>
                    <span>{{ row.tree1.length }} / {{ row.tree2.length }}</span>
                  </div>
                }
              </div>
            </details>
            @if (it.equipmentWarning) {
              <div class="text-xs text-warning">{{ it.equipmentWarning }}</div>
            }
            @if (it.data.capturedAt) {
              <div class="text-xs opacity-50 mt-1">Captured {{ it.data.capturedAt.toLocaleString() }}</div>
            }
          </div>
          <div class="card-actions flex-col">
            <button class="btn btn-primary btn-sm btn-block" (click)="handleApply()">Apply to current character</button>
            @if (canCreate()) {
              <button class="btn btn-sm btn-block" (click)="handleCreate()">Create new character</button>
            }
            @if (it.equipment.length) {
              <button class="btn btn-sm btn-block" (click)="handleCreateGearset()">Create gear set from equipment</button>
            }
            @if (it.skillTrees.length) {
              <button class="btn btn-sm btn-block" (click)="handleCreateSkillTrees()">
                Create skill trees ({{ it.skillTrees.length }})
              </button>
            }
          </div>
        }
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NwModule],
  host: {
    class: 'contents',
  },
})
export class LedgerImportComponent {
  private db = injectNwData()
  private service = inject(CharactersService)
  private store = inject(CharacterStore)
  private modal = inject(ModalService)
  private gearsets = inject(GearsetsService)
  private skillTrees = inject(SkillTreesService)
  private translate = inject(TranslateService)
  private router = inject(Router)

  protected busy = signal(false)
  protected error = signal<string>(null)
  protected result = signal<LedgerImportResult>(null)
  protected canCreate = computed(() => this.service.count() < 5)

  protected async handleFile(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) {
      return
    }
    this.busy.set(true)
    this.error.set(null)
    this.result.set(null)
    try {
      const [progression, territories, abilities, itemTables] = await Promise.all([
        this.db.categoricalProgressionAll(),
        this.db.territoriesAll(),
        this.db.abilitiesAll(),
        Promise.all(
          Object.values(DATASHEETS.MasterItemDefinitions).map(async (sheet) => ({
            uri: sheet.uri as string,
            rows: await this.db.loadDatasheet(sheet),
          })),
        ),
      ])
      const result = await readLedgerImport(file, {
        categoricalProgressionIds: progression.map((it) => it.CategoricalProgressionId),
        territories: territories
          .filter((it) => it.IsTerritory)
          .map((it) => ({ id: it.TerritoryID, label: it.NameLocalizationKey })),
        itemTables,
        abilities,
      })
      this.result.set(result)
    } catch (e) {
      console.error(e)
      if (e instanceof LedgerFormatError || e instanceof LedgerCharacterNotFoundError) {
        this.error.set(e.message)
      } else {
        this.error.set('Failed to read the capture file.')
      }
    } finally {
      this.busy.set(false)
    }
  }

  protected async handleApply() {
    const result = this.result()
    const record = this.store.record()
    if (!result || !record) {
      return
    }
    await this.store.update(applyLedgerImport(record, result))
    this.done(result)
  }

  protected async handleCreate() {
    const result = this.result()
    if (!result) {
      return
    }
    const record = await this.service.create(applyLedgerImport({}, result))
    this.store.load(record.id)
    this.done(result)
  }

  protected async handleCreateGearset() {
    const result = this.result()
    if (!result?.equipment.length) {
      return
    }
    const record = await this.gearsets.create(ledgerGearset(result))
    this.modal.showToast({
      message: `Gear set "${record.name}" created`,
      duration: 3000,
      color: 'success',
    })
    this.router.navigate(['/gearsets', record.userId || 'local', record.id])
  }

  protected async handleCreateSkillTrees() {
    const result = this.result()
    if (!result?.skillTrees.length) {
      return
    }
    for (const tree of result.skillTrees) {
      await this.skillTrees.create({
        name: `${result.name || 'Character'} – ${this.translate.get(tree.label)}`,
        weapon: tree.weapon,
        tree1: tree.tree1,
        tree2: tree.tree2,
        tags: ['import'],
      })
    }
    this.modal.showToast({
      message: `${result.skillTrees.length} skill trees created`,
      duration: 3000,
      color: 'success',
    })
    this.router.navigate(['/skill-trees'])
  }

  private done(result: LedgerImportResult) {
    this.result.set(null)
    this.modal.showToast({
      message: `Imported ${result.name || 'character'} from ${result.fileName}`,
      duration: 3000,
      color: 'success',
    })
  }
}

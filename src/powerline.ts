import type { ClaudeHookData } from "./utils/claude";
import type { PowerlineColors, ColorTheme } from "./themes";
import type { PowerlineConfig, LineConfig } from "./config/loader";
import {
  hexToAnsi,
  extractBgToFg,
  getColorSupport,
  hexToBasicAnsi,
  hexTo256Ansi,
} from "./utils/colors";
import { getTheme } from "./themes";
import {
  UsageProvider,
  UsageInfo,
  ContextProvider,
  ContextInfo,
  GitService,
  TmuxService,
  MetricsProvider,
  MetricsInfo,
  SegmentRenderer,
  PowerlineSymbols,
  AnySegmentConfig,
  DirectorySegmentConfig,
  GitSegmentConfig,
  UsageSegmentConfig,
  ContextSegmentConfig,
  MetricsSegmentConfig,
  BlockSegmentConfig,
  TodaySegmentConfig,
  VersionSegmentConfig,
  StronkAgentsModeSegmentConfig,
  StronkAgentsRalphSegmentConfig,
  StronkAgentsAgentsSegmentConfig,
  StronkAgentsSkillSegmentConfig,
  BurnRateSegmentConfig,
  StronkAgentsProvider,
  StronkAgentsInfo,
} from "./segments";
import { BlockProvider, BlockInfo } from "./segments/block";
import { TodayProvider, TodayInfo } from "./segments/today";
import { SYMBOLS, TEXT_SYMBOLS, RESET_CODE } from "./utils/constants";
import { getTerminalWidth, visibleLength } from "./utils/terminal";

interface RenderedSegment {
  type: string;
  text: string;
  bgColor: string;
  fgColor: string;
}

export class PowerlineRenderer {
  private readonly symbols: PowerlineSymbols;
  private _usageProvider?: UsageProvider;
  private _blockProvider?: BlockProvider;
  private _todayProvider?: TodayProvider;
  private _contextProvider?: ContextProvider;
  private _gitService?: GitService;
  private _tmuxService?: TmuxService;
  private _metricsProvider?: MetricsProvider;
  private _segmentRenderer?: SegmentRenderer;
  private _stronkAgentsProvider?: StronkAgentsProvider;

  constructor(private readonly config: PowerlineConfig) {
    this.symbols = this.initializeSymbols();
  }

  private get usageProvider(): UsageProvider {
    if (!this._usageProvider) {
      this._usageProvider = new UsageProvider();
    }
    return this._usageProvider;
  }

  private get blockProvider(): BlockProvider {
    if (!this._blockProvider) {
      this._blockProvider = new BlockProvider();
    }
    return this._blockProvider;
  }

  private get todayProvider(): TodayProvider {
    if (!this._todayProvider) {
      this._todayProvider = new TodayProvider();
    }
    return this._todayProvider;
  }

  private get contextProvider(): ContextProvider {
    if (!this._contextProvider) {
      this._contextProvider = new ContextProvider(this.config);
    }
    return this._contextProvider;
  }

  private get gitService(): GitService {
    if (!this._gitService) {
      this._gitService = new GitService();
    }
    return this._gitService;
  }

  private get tmuxService(): TmuxService {
    if (!this._tmuxService) {
      this._tmuxService = new TmuxService();
    }
    return this._tmuxService;
  }

  private get metricsProvider(): MetricsProvider {
    if (!this._metricsProvider) {
      this._metricsProvider = new MetricsProvider();
    }
    return this._metricsProvider;
  }

  private get segmentRenderer(): SegmentRenderer {
    if (!this._segmentRenderer) {
      this._segmentRenderer = new SegmentRenderer(this.config, this.symbols);
    }
    return this._segmentRenderer;
  }

  private get stronkAgentsProvider(): StronkAgentsProvider {
    if (!this._stronkAgentsProvider) {
      this._stronkAgentsProvider = new StronkAgentsProvider();
    }
    return this._stronkAgentsProvider;
  }

  private needsSegmentInfo(segmentType: keyof LineConfig["segments"]): boolean {
    return this.config.display.lines.some(
      (line) => line.segments[segmentType]?.enabled
    );
  }

  async generateStatusline(hookData: ClaudeHookData): Promise<string> {
    const usageInfo = this.needsSegmentInfo("session")
      ? await this.usageProvider.getUsageInfo(hookData.session_id, hookData)
      : null;

    const blockInfo = this.needsSegmentInfo("block")
      ? await this.blockProvider.getActiveBlockInfo()
      : null;

    const todayInfo = this.needsSegmentInfo("today")
      ? await this.todayProvider.getTodayInfo()
      : null;

    const contextInfo = this.needsSegmentInfo("context")
      ? await this.contextProvider.getContextInfo(hookData)
      : null;

    const metricsInfo = this.needsSegmentInfo("metrics")
      ? await this.metricsProvider.getMetricsInfo(hookData.session_id, hookData)
      : null;

    const needsStronkAgentsInfo =
      this.needsSegmentInfo("stronkAgentsMode") ||
      this.needsSegmentInfo("stronkAgentsRalph") ||
      this.needsSegmentInfo("stronkAgentsAgents") ||
      this.needsSegmentInfo("stronkAgentsSkill");
    const stronkAgentsInfo = needsStronkAgentsInfo
      ? await this.stronkAgentsProvider.getStronkAgentsInfo(hookData, {
          needsSkill: this.needsSegmentInfo("stronkAgentsSkill"),
          needsAgents: this.needsSegmentInfo("stronkAgentsAgents"),
        })
      : null;

    if (this.config.display.autoWrap) {
      return this.generateAutoWrapStatusline(
        hookData,
        usageInfo,
        blockInfo,
        todayInfo,
        contextInfo,
        metricsInfo,
        stronkAgentsInfo
      );
    }

    const lines = await Promise.all(
      this.config.display.lines.map((lineConfig) =>
        this.renderLine(
          lineConfig,
          hookData,
          usageInfo,
          blockInfo,
          todayInfo,
          contextInfo,
          metricsInfo,
          stronkAgentsInfo
        )
      )
    );

    return lines.filter((line) => line.length > 0).join("\n");
  }

  private async generateAutoWrapStatusline(
    hookData: ClaudeHookData,
    usageInfo: UsageInfo | null,
    blockInfo: BlockInfo | null,
    todayInfo: TodayInfo | null,
    contextInfo: ContextInfo | null,
    metricsInfo: MetricsInfo | null,
    stronkAgentsInfo: StronkAgentsInfo | null
  ): Promise<string> {
    const colors = this.getThemeColors();
    const currentDir = hookData.workspace?.current_dir || hookData.cwd || "/";
    const terminalWidth = getTerminalWidth();

    const outputLines: string[] = [];

    for (const lineConfig of this.config.display.lines) {
      const segments = Object.entries(lineConfig.segments)
        .filter(
          ([_, config]: [string, AnySegmentConfig | undefined]) => config?.enabled
        )
        .map(([type, config]: [string, AnySegmentConfig]) => ({ type, config }));

      const renderedSegments: RenderedSegment[] = [];
      for (const segment of segments) {
        const segmentData = await this.renderSegment(
          segment,
          hookData,
          usageInfo,
          blockInfo,
          todayInfo,
          contextInfo,
          metricsInfo,
          stronkAgentsInfo,
          colors,
          currentDir
        );

        if (segmentData) {
          renderedSegments.push({
            type: segment.type,
            text: segmentData.text,
            bgColor: segmentData.bgColor,
            fgColor: segmentData.fgColor,
          });
        }
      }

      if (renderedSegments.length === 0) continue;

      if (!terminalWidth || terminalWidth <= 0) {
        outputLines.push(this.buildLineFromSegments(renderedSegments, colors));
        continue;
      }

      let currentLineSegments: RenderedSegment[] = [];
      let currentLineWidth = 0;

      for (const segment of renderedSegments) {
        const segmentWidth = this.calculateSegmentWidth(segment, currentLineSegments.length === 0);

        if (currentLineSegments.length > 0 && currentLineWidth + segmentWidth > terminalWidth) {
          outputLines.push(this.buildLineFromSegments(currentLineSegments, colors));
          currentLineSegments = [];
          currentLineWidth = 0;
        }

        currentLineSegments.push(segment);
        currentLineWidth += segmentWidth;
      }

      if (currentLineSegments.length > 0) {
        outputLines.push(this.buildLineFromSegments(currentLineSegments, colors));
      }
    }

    return outputLines.join("\n");
  }

  private calculateSegmentWidth(segment: RenderedSegment, isFirst: boolean): number {
    const isCapsuleStyle = this.config.display.style === "capsule";
    const textWidth = visibleLength(segment.text);
    const padding = this.config.display.padding ?? 1;
    const paddingWidth = padding * 2;

    if (isCapsuleStyle) {
      const capsuleOverhead = 2 + paddingWidth + (isFirst ? 0 : 1);
      return textWidth + capsuleOverhead;
    }

    const powerlineOverhead = 1 + paddingWidth;
    return textWidth + powerlineOverhead;
  }

  private buildLineFromSegments(
    segments: RenderedSegment[],
    colors: PowerlineColors
  ): string {
    const isCapsuleStyle = this.config.display.style === "capsule";
    let line = colors.reset;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      if (!segment) continue;

      const isFirst = i === 0;
      const isLast = i === segments.length - 1;
      const nextSegment = !isLast ? segments[i + 1] : null;
      // Codex Fix 1: Use actual rendered bgColor instead of static theme color
      // This ensures stronk-agents segments with dynamic backgrounds get correct separator colors

      if (isCapsuleStyle && !isFirst) {
        line += " ";
      }

      line += this.formatSegment(
        segment.bgColor,
        segment.fgColor,
        segment.text,
        nextSegment?.bgColor,
        colors
      );
    }

    return line;
  }

  private async renderLine(
    lineConfig: LineConfig,
    hookData: ClaudeHookData,
    usageInfo: UsageInfo | null,
    blockInfo: BlockInfo | null,
    todayInfo: TodayInfo | null,
    contextInfo: ContextInfo | null,
    metricsInfo: MetricsInfo | null,
    stronkAgentsInfo: StronkAgentsInfo | null
  ): Promise<string> {
    const colors = this.getThemeColors();
    const currentDir = hookData.workspace?.current_dir || hookData.cwd || "/";

    const segments = Object.entries(lineConfig.segments)
      .filter(
        ([_, config]: [string, AnySegmentConfig | undefined]) => config?.enabled
      )
      .map(([type, config]: [string, AnySegmentConfig]) => ({ type, config }));

    // Pre-render all segments first (Codex Fix 1: needed to get actual bgColors)
    const renderedSegments: RenderedSegment[] = [];
    for (const segment of segments) {
      const segmentData = await this.renderSegment(
        segment,
        hookData,
        usageInfo,
        blockInfo,
        todayInfo,
        contextInfo,
        metricsInfo,
        stronkAgentsInfo,
        colors,
        currentDir
      );

      if (segmentData) {
        renderedSegments.push({
          type: segment.type,
          text: segmentData.text,
          bgColor: segmentData.bgColor,
          fgColor: segmentData.fgColor,
        });
      }
    }

    return this.buildLineFromSegments(renderedSegments, colors);
  }

  private async renderSegment(
    segment: { type: string; config: AnySegmentConfig },
    hookData: ClaudeHookData,
    usageInfo: UsageInfo | null,
    blockInfo: BlockInfo | null,
    todayInfo: TodayInfo | null,
    contextInfo: ContextInfo | null,
    metricsInfo: MetricsInfo | null,
    stronkAgentsInfo: StronkAgentsInfo | null,
    colors: PowerlineColors,
    currentDir: string
  ) {
    if (segment.type === "directory") {
      return this.segmentRenderer.renderDirectory(
        hookData,
        colors,
        segment.config as DirectorySegmentConfig
      );
    }
    if (segment.type === "model") {
      return this.segmentRenderer.renderModel(hookData, colors);
    }

    if (segment.type === "git") {
      return await this.renderGitSegment(
        segment.config as GitSegmentConfig,
        hookData,
        colors,
        currentDir
      );
    }

    if (segment.type === "session") {
      return this.renderSessionSegment(
        segment.config as UsageSegmentConfig,
        usageInfo,
        colors
      );
    }

    if (segment.type === "burnRate") {
      return this.renderBurnRateSegment(
        segment.config as BurnRateSegmentConfig,
        usageInfo,
        colors
      );
    }

    if (segment.type === "tmux") {
      return await this.renderTmuxSegment(colors);
    }

    if (segment.type === "context") {
      return this.renderContextSegment(
        segment.config as ContextSegmentConfig,
        contextInfo,
        colors
      );
    }

    if (segment.type === "metrics") {
      return this.renderMetricsSegment(
        segment.config as MetricsSegmentConfig,
        metricsInfo,
        blockInfo,
        colors
      );
    }

    if (segment.type === "block") {
      return this.renderBlockSegment(
        segment.config as BlockSegmentConfig,
        blockInfo,
        colors
      );
    }

    if (segment.type === "today") {
      return this.renderTodaySegment(
        segment.config as TodaySegmentConfig,
        todayInfo,
        colors
      );
    }

    if (segment.type === "version") {
      return this.renderVersionSegment(
        segment.config as VersionSegmentConfig,
        hookData,
        colors
      );
    }

    if (segment.type === "stronkAgentsMode") {
      return this.segmentRenderer.renderStronkAgentsMode(
        stronkAgentsInfo?.mode ?? null,
        colors,
        segment.config as StronkAgentsModeSegmentConfig
      );
    }

    if (segment.type === "stronkAgentsRalph") {
      return this.segmentRenderer.renderStronkAgentsRalph(
        stronkAgentsInfo?.ralph ?? null,
        colors,
        segment.config as StronkAgentsRalphSegmentConfig
      );
    }

    if (segment.type === "stronkAgentsAgents") {
      return this.segmentRenderer.renderStronkAgentsAgents(
        stronkAgentsInfo?.agents ?? null,
        colors,
        segment.config as StronkAgentsAgentsSegmentConfig
      );
    }

    if (segment.type === "stronkAgentsSkill") {
      return this.segmentRenderer.renderStronkAgentsSkill(
        stronkAgentsInfo?.skill ?? null,
        colors,
        segment.config as StronkAgentsSkillSegmentConfig
      );
    }

    return null;
  }

  private async renderGitSegment(
    config: GitSegmentConfig,
    hookData: ClaudeHookData,
    colors: PowerlineColors,
    currentDir: string
  ) {
    if (!this.needsSegmentInfo("git")) return null;

    const gitInfo = await this.gitService.getGitInfo(
      currentDir,
      {
        showSha: config?.showSha,
        showWorkingTree: config?.showWorkingTree,
        showOperation: config?.showOperation,
        showTag: config?.showTag,
        showTimeSinceCommit: config?.showTimeSinceCommit,
        showStashCount: config?.showStashCount,
        showUpstream: config?.showUpstream,
        showRepoName: config?.showRepoName,
      },
      hookData.workspace?.project_dir
    );

    return gitInfo
      ? this.segmentRenderer.renderGit(gitInfo, colors, config)
      : null;
  }

  private renderSessionSegment(
    config: UsageSegmentConfig,
    usageInfo: UsageInfo | null,
    colors: PowerlineColors
  ) {
    if (!usageInfo) return null;
    return this.segmentRenderer.renderSession(usageInfo, colors, config);
  }

  private renderBurnRateSegment(
    config: BurnRateSegmentConfig,
    usageInfo: UsageInfo | null,
    colors: PowerlineColors
  ) {
    if (!usageInfo) return null;
    return this.segmentRenderer.renderBurnRate(usageInfo, colors, config);
  }

  private async renderTmuxSegment(colors: PowerlineColors) {
    if (!this.needsSegmentInfo("tmux")) return null;
    const tmuxSessionId = await this.tmuxService.getSessionId();
    return this.segmentRenderer.renderTmux(tmuxSessionId, colors);
  }

  private renderContextSegment(
    config: ContextSegmentConfig,
    contextInfo: ContextInfo | null,
    colors: PowerlineColors
  ) {
    if (!this.needsSegmentInfo("context")) return null;
    return this.segmentRenderer.renderContext(contextInfo, colors, config);
  }

  private renderMetricsSegment(
    config: MetricsSegmentConfig,
    metricsInfo: MetricsInfo | null,
    blockInfo: BlockInfo | null,
    colors: PowerlineColors
  ) {
    return this.segmentRenderer.renderMetrics(
      metricsInfo,
      colors,
      blockInfo,
      config
    );
  }

  private renderBlockSegment(
    config: BlockSegmentConfig,
    blockInfo: BlockInfo | null,
    colors: PowerlineColors
  ) {
    if (!blockInfo) return null;
    return this.segmentRenderer.renderBlock(blockInfo, colors, config);
  }

  private renderTodaySegment(
    config: TodaySegmentConfig,
    todayInfo: TodayInfo | null,
    colors: PowerlineColors
  ) {
    if (!todayInfo) return null;
    const todayType = config?.type || "cost";
    return this.segmentRenderer.renderToday(todayInfo, colors, todayType);
  }

  private renderVersionSegment(
    config: VersionSegmentConfig,
    hookData: ClaudeHookData,
    colors: PowerlineColors
  ) {
    return this.segmentRenderer.renderVersion(hookData, colors, config);
  }

  private initializeSymbols(): PowerlineSymbols {
    const style = this.config.display.style;
    const charset = this.config.display.charset || "unicode";
    const isMinimalStyle = style === "minimal";
    const isCapsuleStyle = style === "capsule";
    const symbolSet = charset === "text" ? TEXT_SYMBOLS : SYMBOLS;

    return {
      right: isMinimalStyle ? "" : (isCapsuleStyle ? symbolSet.right_rounded : symbolSet.right),
      left: isCapsuleStyle ? symbolSet.left_rounded : "",
      branch: symbolSet.branch,
      model: symbolSet.model,
      git_clean: symbolSet.git_clean,
      git_dirty: symbolSet.git_dirty,
      git_conflicts: symbolSet.git_conflicts,
      git_ahead: symbolSet.git_ahead,
      git_behind: symbolSet.git_behind,
      git_worktree: symbolSet.git_worktree,
      git_tag: symbolSet.git_tag,
      git_sha: symbolSet.git_sha,
      git_upstream: symbolSet.git_upstream,
      git_stash: symbolSet.git_stash,
      git_time: symbolSet.git_time,
      session_cost: symbolSet.session_cost,
      block_cost: symbolSet.block_cost,
      today_cost: symbolSet.today_cost,
      context_time: symbolSet.context_time,
      metrics_response: symbolSet.metrics_response,
      metrics_last_response: symbolSet.metrics_last_response,
      metrics_duration: symbolSet.metrics_duration,
      metrics_messages: symbolSet.metrics_messages,
      metrics_lines_added: symbolSet.metrics_lines_added,
      metrics_lines_removed: symbolSet.metrics_lines_removed,
      metrics_burn: symbolSet.metrics_burn,
      version: symbolSet.version,
      bar_filled: symbolSet.bar_filled,
      bar_empty: symbolSet.bar_empty,
      stronk_agents_mode_ultrawork: symbolSet.stronk_agents_mode_ultrawork,
      stronk_agents_mode_autopilot: symbolSet.stronk_agents_mode_autopilot,
      stronk_agents_mode_ecomode: symbolSet.stronk_agents_mode_ecomode,
      stronk_agents_mode_inactive: symbolSet.stronk_agents_mode_inactive,
      stronk_agents_ralph: symbolSet.stronk_agents_ralph,
      stronk_agents_agents: symbolSet.stronk_agents_agents,
      stronk_agents_skill: symbolSet.stronk_agents_skill,
    };
  }

  private getThemeColors(): PowerlineColors {
    const theme = this.config.theme;
    let colorTheme;

    const colorMode = this.config.display.colorCompatibility || "auto";
    const colorSupport = colorMode === "auto" ? getColorSupport() : colorMode;

    if (theme === "custom") {
      colorTheme = this.config.colors?.custom;
      if (!colorTheme) {
        throw new Error(
          "Custom theme selected but no colors provided in configuration"
        );
      }
    } else {
      colorTheme = getTheme(theme, colorSupport);
      if (!colorTheme) {
        console.warn(
          `Built-in theme '${theme}' not found, falling back to 'dark' theme`
        );
        colorTheme = getTheme("dark", colorSupport)!;
      }
    }

    const fallbackTheme = getTheme("dark", colorSupport)!;

    const getSegmentColors = (segment: keyof ColorTheme) => {
      const colors = colorTheme[segment] || fallbackTheme[segment];

      // Guard for optional segment colors (e.g., model tier colors)
      if (!colors) {
        return { bg: "", fg: "" };
      }

      if (colorSupport === "none") {
        return {
          bg: "",
          fg: "",
        };
      } else if (colorSupport === "ansi") {
        return {
          bg: hexToBasicAnsi(colors.bg, true),
          fg: hexToBasicAnsi(colors.fg, false),
        };
      } else if (colorSupport === "ansi256") {
        return {
          bg: hexTo256Ansi(colors.bg, true),
          fg: hexTo256Ansi(colors.fg, false),
        };
      } else {
        return {
          bg: hexToAnsi(colors.bg, true),
          fg: hexToAnsi(colors.fg, false),
        };
      }
    };

    const directory = getSegmentColors("directory");
    const git = getSegmentColors("git");
    const model = getSegmentColors("model");
    const session = getSegmentColors("session");
    const block = getSegmentColors("block");
    const today = getSegmentColors("today");
    const tmux = getSegmentColors("tmux");
    const context = getSegmentColors("context");
    const contextWarning = getSegmentColors("contextWarning");
    const contextCritical = getSegmentColors("contextCritical");
    const metrics = getSegmentColors("metrics");
    const version = getSegmentColors("version");
    const stronkAgentsModeActive = getSegmentColors("stronkAgentsModeActive");
    const stronkAgentsModeInactive = getSegmentColors("stronkAgentsModeInactive");
    const stronkAgentsRalphActive = getSegmentColors("stronkAgentsRalphActive");
    const stronkAgentsRalphWarn = getSegmentColors("stronkAgentsRalphWarn");
    const stronkAgentsRalphMax = getSegmentColors("stronkAgentsRalphMax");
    const stronkAgentsRalphInactive = getSegmentColors("stronkAgentsRalphInactive");
    const stronkAgentsAgentsActive = getSegmentColors("stronkAgentsAgentsActive");
    const stronkAgentsAgentsInactive = getSegmentColors("stronkAgentsAgentsInactive");
    const stronkAgentsSkillActive = getSegmentColors("stronkAgentsSkillActive");
    const stronkAgentsSkillInactive = getSegmentColors("stronkAgentsSkillInactive");

    // Model tier colors - optional with graceful fallback
    const getOptionalSegmentColors = (segment: keyof ColorTheme) => {
      const colors = colorTheme[segment];
      if (!colors) return null;

      if (colorSupport === "none") {
        return { bg: "", fg: "" };
      } else if (colorSupport === "ansi") {
        return {
          bg: hexToBasicAnsi(colors.bg, true),
          fg: hexToBasicAnsi(colors.fg, false),
        };
      } else if (colorSupport === "ansi256") {
        return {
          bg: hexTo256Ansi(colors.bg, true),
          fg: hexTo256Ansi(colors.fg, false),
        };
      } else {
        return {
          bg: hexToAnsi(colors.bg, true),
          fg: hexToAnsi(colors.fg, false),
        };
      }
    };

    const stronkAgentsAgentOpus = getOptionalSegmentColors("stronkAgentsAgentOpus");
    const stronkAgentsAgentSonnet = getOptionalSegmentColors("stronkAgentsAgentSonnet");
    const stronkAgentsAgentHaiku = getOptionalSegmentColors("stronkAgentsAgentHaiku");

    const costNormal = getOptionalSegmentColors("costNormal");
    const costWarning = getOptionalSegmentColors("costWarning");
    const costCritical = getOptionalSegmentColors("costCritical");
    const burnRate = getOptionalSegmentColors("burnRate");

    return {
      reset: colorSupport === "none" ? "" : RESET_CODE,
      modeBg: directory.bg,
      modeFg: directory.fg,
      gitBg: git.bg,
      gitFg: git.fg,
      modelBg: model.bg,
      modelFg: model.fg,
      sessionBg: session.bg,
      sessionFg: session.fg,
      blockBg: block.bg,
      blockFg: block.fg,
      todayBg: today.bg,
      todayFg: today.fg,
      tmuxBg: tmux.bg,
      tmuxFg: tmux.fg,
      contextBg: context.bg,
      contextFg: context.fg,
      contextWarningBg: contextWarning.bg,
      contextWarningFg: contextWarning.fg,
      contextCriticalBg: contextCritical.bg,
      contextCriticalFg: contextCritical.fg,
      metricsBg: metrics.bg,
      metricsFg: metrics.fg,
      versionBg: version.bg,
      versionFg: version.fg,
      stronkAgentsModeActiveBg: stronkAgentsModeActive.bg,
      stronkAgentsModeActiveFg: stronkAgentsModeActive.fg,
      stronkAgentsModeInactiveBg: stronkAgentsModeInactive.bg,
      stronkAgentsModeInactiveFg: stronkAgentsModeInactive.fg,
      stronkAgentsRalphActiveBg: stronkAgentsRalphActive.bg,
      stronkAgentsRalphActiveFg: stronkAgentsRalphActive.fg,
      stronkAgentsRalphWarnBg: stronkAgentsRalphWarn.bg,
      stronkAgentsRalphWarnFg: stronkAgentsRalphWarn.fg,
      stronkAgentsRalphMaxBg: stronkAgentsRalphMax.bg,
      stronkAgentsRalphMaxFg: stronkAgentsRalphMax.fg,
      stronkAgentsRalphInactiveBg: stronkAgentsRalphInactive.bg,
      stronkAgentsRalphInactiveFg: stronkAgentsRalphInactive.fg,
      stronkAgentsAgentsActiveBg: stronkAgentsAgentsActive.bg,
      stronkAgentsAgentsActiveFg: stronkAgentsAgentsActive.fg,
      stronkAgentsAgentsInactiveBg: stronkAgentsAgentsInactive.bg,
      stronkAgentsAgentsInactiveFg: stronkAgentsAgentsInactive.fg,
      stronkAgentsSkillActiveBg: stronkAgentsSkillActive.bg,
      stronkAgentsSkillActiveFg: stronkAgentsSkillActive.fg,
      stronkAgentsSkillInactiveBg: stronkAgentsSkillInactive.bg,
      stronkAgentsSkillInactiveFg: stronkAgentsSkillInactive.fg,
      // Model tier colors (optional - only present if theme defines them)
      ...(stronkAgentsAgentOpus && {
        stronkAgentsAgentOpusBg: stronkAgentsAgentOpus.bg,
        stronkAgentsAgentOpusFg: stronkAgentsAgentOpus.fg,
      }),
      ...(stronkAgentsAgentSonnet && {
        stronkAgentsAgentSonnetBg: stronkAgentsAgentSonnet.bg,
        stronkAgentsAgentSonnetFg: stronkAgentsAgentSonnet.fg,
      }),
      ...(stronkAgentsAgentHaiku && {
        stronkAgentsAgentHaikuBg: stronkAgentsAgentHaiku.bg,
        stronkAgentsAgentHaikuFg: stronkAgentsAgentHaiku.fg,
      }),
      ...(costNormal && {
        costNormalBg: costNormal.bg,
        costNormalFg: costNormal.fg,
      }),
      ...(costWarning && {
        costWarningBg: costWarning.bg,
        costWarningFg: costWarning.fg,
      }),
      ...(costCritical && {
        costCriticalBg: costCritical.bg,
        costCriticalFg: costCritical.fg,
      }),
      ...(burnRate && {
        burnRateBg: burnRate.bg,
        burnRateFg: burnRate.fg,
      }),
    };
  }

  private formatSegment(
    bgColor: string,
    fgColor: string,
    text: string,
    nextBgColor: string | undefined,
    colors: PowerlineColors
  ): string {
    const isCapsuleStyle = this.config.display.style === "capsule";
    const padding = " ".repeat(this.config.display.padding ?? 1);

    if (isCapsuleStyle) {
      const colorMode = this.config.display.colorCompatibility || "auto";
      const colorSupport = colorMode === "auto" ? getColorSupport() : colorMode;
      const isBasicMode = colorSupport === "ansi";

      const capFgColor = extractBgToFg(bgColor, isBasicMode);

      const leftCap = `${capFgColor}${this.symbols.left}${colors.reset}`;

      const content = `${bgColor}${fgColor}${padding}${text}${padding}${colors.reset}`;

      const rightCap = `${capFgColor}${this.symbols.right}${colors.reset}`;

      return `${leftCap}${content}${rightCap}`;
    }

    let output = `${bgColor}${fgColor}${padding}${text}${padding}`;

    const colorMode = this.config.display.colorCompatibility || "auto";
    const colorSupport = colorMode === "auto" ? getColorSupport() : colorMode;
    const isBasicMode = colorSupport === "ansi";

    if (nextBgColor) {
      const arrowFgColor = extractBgToFg(bgColor, isBasicMode);
      output += `${colors.reset}${nextBgColor}${arrowFgColor}${this.symbols.right}`;
    } else {
      output += `${colors.reset}${extractBgToFg(bgColor, isBasicMode)}${this.symbols.right}${colors.reset}`;
    }

    return output;
  }
}

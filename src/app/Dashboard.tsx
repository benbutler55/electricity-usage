import { StatusBar } from '../components/header/StatusBar'
import { Shell } from '../components/layout/Shell'
import { SectionGrid } from '../components/layout/SectionGrid'
import { TodaySummaryCard } from '../components/cards/TodaySummaryCard'
import { CostAnalysisCard } from '../components/cards/CostAnalysisCard'
import { MonthlySummaryCard } from '../components/cards/MonthlySummaryCard'
import { AgileLineChart } from '../components/charts/AgileLineChart'
import { ConsumptionOverlay } from '../components/charts/ConsumptionOverlay'
import { DailyCostBarChart } from '../components/charts/DailyCostBarChart'
import { HeatmapGrid } from '../components/charts/HeatmapGrid'
import { BatteryOptimiser } from '../components/battery/BatteryOptimiser'

export default function Dashboard() {
  return (
    <>
      <StatusBar />
      <Shell>
        <div className="mt-6">
          <TodaySummaryCard />
        </div>

        <SectionGrid cols={2}>
          <AgileLineChart />
          <ConsumptionOverlay />
        </SectionGrid>

        <SectionGrid cols={2}>
          <DailyCostBarChart />
          <CostAnalysisCard />
        </SectionGrid>

        <SectionGrid cols={1}>
          <HeatmapGrid />
        </SectionGrid>

        <SectionGrid cols={1}>
          <BatteryOptimiser />
        </SectionGrid>

        <SectionGrid cols={1}>
          <MonthlySummaryCard />
        </SectionGrid>
      </Shell>
    </>
  )
}

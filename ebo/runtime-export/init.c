static const float EXPORT_MAP_SIZE = 15360.0;
static const float EXPORT_STEP = 200.0;
static const float EXPORT_RADIUS = 150.0;

void main()
{
	// Deliberately do not initialize the Hive/Central Economy. The export must
	// contain terrain placements only, without loot, infected, events or other
	// dynamically spawned entities.
}

class SakhalPlacementExporter
{
	protected ref map<string, int> m_ShapeCounts = new map<string, int>;
	protected FileHandle m_Output;
	protected int m_Columns;
	protected int m_Rows;
	protected int m_Cell;
	protected int m_Exported;
	protected int m_Roads;
	protected int m_Vegetation;

	void SakhalPlacementExporter()
	{
		m_Columns = Math.Ceil(EXPORT_MAP_SIZE / EXPORT_STEP) + 1;
		m_Rows = m_Columns;
		Print(string.Format("[SakhalExport] Started full-map export: %1 x %2 query cells", m_Columns, m_Rows));
		GetGame().GetCallQueue(CALL_CATEGORY_SYSTEM).CallLater(ProcessNextCell, 25, false);
	}

	protected void ProcessNextCell()
	{
		if (m_Cell >= m_Columns * m_Rows)
		{
			Finish();
			return;
		}

		int column = m_Cell % m_Columns;
		int row = m_Cell / m_Columns;
		if (column == 0)
		{
			string rowFile = string.Format("$profile:sakhal-placement-row-%1.tsv", row);
			m_Output = OpenFile(rowFile, FileMode.WRITE);
			FPrintln(m_Output, "shape\tclass\tr0\tr1\tr2\tr3\tscale");
		}
		vector center = Vector(column * EXPORT_STEP, 0, row * EXPORT_STEP);
		array<Object> objects = new array<Object>;
		array<CargoBase> proxies = new array<CargoBase>;
		GetGame().GetObjectsAtPosition(center, EXPORT_RADIUS, objects, proxies);

		foreach (Object object : objects)
		{
			if (!object)
				continue;
			string shape = object.GetShapeName();
			if (shape == string.Empty)
				continue;
			vector transform[4];
			object.GetTransform(transform);
			vector position = transform[3];
			if (position[0] < 0 || position[2] < 0 || position[0] > EXPORT_MAP_SIZE || position[2] > EXPORT_MAP_SIZE)
				continue;
			// Overlapping query circles guarantee coverage. Assign each placement to
			// its nearest query center so it is emitted exactly once without retaining
			// millions of deduplication keys in server memory.
			int ownerColumn = Math.Floor((position[0] + EXPORT_STEP * 0.5) / EXPORT_STEP);
			int ownerRow = Math.Floor((position[2] + EXPORT_STEP * 0.5) / EXPORT_STEP);
			if (ownerColumn != column || ownerRow != row)
				continue;

			string lower = shape;
			lower.ToLower();
			if (lower.Contains("road"))
				m_Roads++;
			if (lower.Contains("plant") || lower.Contains("tree") || lower.Contains("bush"))
				m_Vegetation++;
			int count;
			if (m_ShapeCounts.Find(shape, count))
				m_ShapeCounts.Set(shape, count + 1);
			else
				m_ShapeCounts.Insert(shape, 1);

			string line = string.Format("%1\t%2\t%3\t%4\t%5\t%6\t%7", shape, object.GetType(), transform[0], transform[1], transform[2], transform[3], object.GetScale());
			FPrintln(m_Output, line);
			m_Exported++;
		}

		m_Cell++;
		if ((m_Cell % m_Columns) == 0)
		{
			CloseFile(m_Output);
			Print(string.Format("[SakhalExport] Row %1/%2; %3 placements", m_Cell / m_Columns, m_Rows, m_Exported));
		}
		GetGame().GetCallQueue(CALL_CATEGORY_SYSTEM).CallLater(ProcessNextCell, 25, false);
	}

	protected void Finish()
	{
		FileHandle summary = OpenFile("$profile:sakhal-placement-summary.tsv", FileMode.WRITE);
		FPrintln(summary, string.Format("objects\t%1", m_Exported));
		FPrintln(summary, string.Format("roads\t%1", m_Roads));
		FPrintln(summary, string.Format("vegetation\t%1", m_Vegetation));
		foreach (string shape, int count : m_ShapeCounts)
			FPrintln(summary, string.Format("shape\t%1\t%2", count, shape));
		CloseFile(summary);
		Print(string.Format("[SakhalExport] COMPLETE: %1 objects, %2 roads, %3 vegetation", m_Exported, m_Roads, m_Vegetation));
	}
}

class CustomMission: MissionServer
{
	protected ref SakhalPlacementExporter m_Exporter;

	override void OnInit()
	{
		super.OnInit();
		m_Exporter = new SakhalPlacementExporter();
	}
}

Mission CreateCustomMission(string path)
{
	return new CustomMission();
}

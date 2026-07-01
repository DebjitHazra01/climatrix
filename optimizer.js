/**
 * optimizer.js - Spatial Optimization Engine for Climatrix SDSS v3.0 (Judges' Choice Edition)
 * Implements a Budget-Constrained Multi-Objective Genetic Algorithm and
 * Heuristic Policy Profile generators for instant strategy comparisons.
 */

class UrbanOptimizer {
  constructor(grid, pimlModel) {
    this.grid = grid;
    this.model = pimlModel;
    this.cache = {}; // Cache of { lst, wbgt } lookup tables
    this.isRunning = false;
  }

  precomputeCache(Ta_C, RH, windSpeed, Rs) {
    this.cache = {};
    const types = Object.keys(LULC_PROPERTIES);

    this.grid.cells.forEach(cell => {
      this.cache[cell.id] = {};
      types.forEach(type => {
        const tempCell = { ...cell, type: type };
        const results = this.model.evaluateCell(tempCell, Ta_C, RH, windSpeed, Rs);
        this.cache[cell.id][type] = {
          lst: results.lst,
          wbgt: results.wbgt
        };
      });
    });
  }

  calculateCost(chromosome) {
    let cost = 0;
    Object.entries(chromosome).forEach(([cellId, type]) => {
      cost += LULC_PROPERTIES[type].cost || 0;
    });
    return cost;
  }

  evaluateFitness(chromosome, objective) {
    let totalLST = 0;
    let totalHVI = 0;
    let hotspotCount = 0;
    const numCells = this.grid.cells.length;

    for (let id = 0; id < numCells; id++) {
      const type = chromosome[id] || this.grid.cells[id].type;
      const cached = this.cache[id][type];
      const cell = this.grid.cells[id];

      totalLST += cached.lst;
      if (cached.wbgt > 32.0) hotspotCount++;

      const hazard = Math.max(0, cached.lst - 30.0);
      const hvi = hazard * cell.vulnerability * (cell.population / 1000.0);
      totalHVI += hvi;
    }

    const avgLST = totalLST / numCells;

    if (objective === 'minimize_lst') {
      return 100.0 - avgLST;
    } else if (objective === 'minimize_hotspots') {
      return numCells - hotspotCount;
    } else if (objective === 'minimize_hvi') {
      return 10000.0 - totalHVI;
    }
    return 0;
  }

  optimize(totalBudget, objective, options = {}) {
    const populationSize = options.populationSize || 30;
    const maxGenerations = options.maxGenerations || 60;
    const mutationRate = options.mutationRate || 0.20;
    const crossoverRate = options.crossoverRate || 0.8;

    this.isRunning = true;
    
    const eligibleCellIds = this.grid.cells
      .filter(cell => cell.originalType !== 'water_body' && cell.originalType !== 'urban_park')
      .map(cell => cell.id);

    if (eligibleCellIds.length === 0) {
      this.isRunning = false;
      if (options.onComplete) options.onComplete(null);
      return;
    }

    let population = [];
    for (let i = 0; i < populationSize; i++) {
      population.push(this.createRandomChromosome(eligibleCellIds, totalBudget));
    }

    let generation = 0;
    
    const runGeneration = () => {
      if (!this.isRunning) return;

      const scoredPopulation = population.map(chromo => {
        return {
          chromo: chromo,
          fitness: this.evaluateFitness(chromo, objective),
          cost: this.calculateCost(chromo)
        };
      });

      scoredPopulation.sort((a, b) => b.fitness - a.fitness);

      const bestIndividual = scoredPopulation[0];
      
      let totalLST = 0;
      let totalHVI = 0;
      let hotspotCount = 0;
      for (let id = 0; id < this.grid.cells.length; id++) {
        const type = bestIndividual.chromo[id] || this.grid.cells[id].type;
        const cached = this.cache[id][type];
        const cell = this.grid.cells[id];
        totalLST += cached.lst;
        if (cached.wbgt > 32.0) hotspotCount++;
        const hazard = Math.max(0, cached.lst - 30.0);
        totalHVI += hazard * cell.vulnerability * (cell.population / 1000.0);
      }
      const avgLST = totalLST / this.grid.cells.length;

      if (options.onGenerationComplete) {
        options.onGenerationComplete(
          generation,
          bestIndividual.chromo,
          avgLST,
          hotspotCount,
          bestIndividual.cost,
          totalHVI
        );
      }

      if (generation >= maxGenerations) {
        this.isRunning = false;
        if (options.onComplete) {
          options.onComplete(bestIndividual.chromo);
        }
        return;
      }

      const nextPopulation = [];
      nextPopulation.push(scoredPopulation[0].chromo);
      nextPopulation.push(scoredPopulation[1].chromo);

      while (nextPopulation.length < populationSize) {
        const parent1 = this.tournamentSelect(scoredPopulation, 3);
        const parent2 = this.tournamentSelect(scoredPopulation, 3);
        let child1, child2;

        if (Math.random() < crossoverRate) {
          [child1, child2] = this.crossover(parent1, parent2, eligibleCellIds, totalBudget);
        } else {
          child1 = { ...parent1 };
          child2 = { ...parent2 };
        }

        child1 = this.mutate(child1, eligibleCellIds, totalBudget, mutationRate);
        child2 = this.mutate(child2, eligibleCellIds, totalBudget, mutationRate);

        nextPopulation.push(child1);
        if (nextPopulation.length < populationSize) {
          nextPopulation.push(child2);
        }
      }

      population = nextPopulation;
      generation++;

      setTimeout(runGeneration, 20);
    };

    runGeneration();
  }

  stop() {
    this.isRunning = false;
  }

  createRandomChromosome(eligibleCellIds, totalBudget) {
    const chromo = {};
    const shuffled = [...eligibleCellIds].sort(() => Math.random() - 0.5);
    const options = ['urban_park', 'cool_roof'];
    
    let cost = 0;
    for (let i = 0; i < shuffled.length; i++) {
      const cellId = shuffled[i];
      const type = options[Math.floor(Math.random() * options.length)];
      const unitCost = LULC_PROPERTIES[type].cost;

      if (cost + unitCost <= totalBudget) {
        chromo[cellId] = type;
        cost += unitCost;
      } else {
        break;
      }
    }
    return chromo;
  }

  tournamentSelect(scoredPopulation, size) {
    let bestCandidate = null;
    for (let i = 0; i < size; i++) {
      const randomInd = scoredPopulation[Math.floor(Math.random() * scoredPopulation.length)];
      if (!bestCandidate || randomInd.fitness > bestCandidate.fitness) {
        bestCandidate = randomInd;
      }
    }
    return bestCandidate.chromo;
  }

  crossover(parent1, parent2, eligibleCellIds, totalBudget) {
    const list1 = Object.entries(parent1).map(([id, type]) => ({ id: parseInt(id), type }));
    const list2 = Object.entries(parent2).map(([id, type]) => ({ id: parseInt(id), type }));
    const crossoverPoint = Math.floor(Math.random() * Math.max(list1.length, 1));
    
    let child1List = [...list1.slice(0, crossoverPoint), ...list2.slice(crossoverPoint)];
    let child2List = [...list2.slice(0, crossoverPoint), ...list1.slice(crossoverPoint)];

    const resolveConstraint = (list) => {
      const chromo = {};
      const usedIds = new Set();
      let cost = 0;
      const shuffledList = [...list].sort(() => Math.random() - 0.5);

      shuffledList.forEach(item => {
        if (!usedIds.has(item.id)) {
          const unitCost = LULC_PROPERTIES[item.type].cost;
          if (cost + unitCost <= totalBudget) {
            chromo[item.id] = item.type;
            usedIds.add(item.id);
            cost += unitCost;
          }
        }
      });
      return chromo;
    };
    return [resolveConstraint(child1List), resolveConstraint(child2List)];
  }

  mutate(chromo, eligibleCellIds, totalBudget, rate) {
    const mutated = { ...chromo };
    const entries = Object.entries(mutated);

    entries.forEach(([id, type]) => {
      if (Math.random() < rate) {
        const cellId = parseInt(id);
        const activeIds = new Set(Object.keys(mutated).map(Number));
        
        if (Math.random() < 0.5) {
          const freeIds = eligibleCellIds.filter(fid => !activeIds.has(fid));
          if (freeIds.length > 0) {
            const newCellId = freeIds[Math.floor(Math.random() * freeIds.length)];
            delete mutated[cellId];
            mutated[newCellId] = type;
          }
        } else {
          const newType = type === 'urban_park' ? 'cool_roof' : 'urban_park';
          const currentCost = this.calculateCost(mutated);
          const diff = LULC_PROPERTIES[newType].cost - LULC_PROPERTIES[type].cost;

          if (currentCost + diff <= totalBudget) {
            mutated[cellId] = newType;
          }
        }
      }
    });

    while (this.calculateCost(mutated) > totalBudget) {
      const keys = Object.keys(mutated);
      const randomKey = keys[Math.floor(Math.random() * keys.length)];
      delete mutated[randomKey];
    }
    return mutated;
  }

  /**
   * Generates analytical policy strategy profiles instantly (Heuristic Solver).
   * Used to populate the comparison dashboard instantly without waiting for long GA runs.
   */
  generateHeuristicPolicies(totalBudget) {
    const eligibleCells = this.grid.cells
      .filter(cell => cell.originalType !== 'water_body' && cell.originalType !== 'urban_park')
      // Sort by vulnerability descending to target the highest-risk regions
      .sort((a, b) => b.vulnerability - a.vulnerability);

    // 1. Green Infrastructure Policy (Only places Trees)
    const greenChromo = {};
    let greenCost = 0;
    const treeCost = LULC_PROPERTIES.urban_park.cost; // $120
    for (let c of eligibleCells) {
      if (greenCost + treeCost <= totalBudget) {
        greenChromo[c.id] = 'urban_park';
        greenCost += treeCost;
      }
    }

    // 2. Cool Roofs Policy (Only places Albedo Coatings)
    const coolChromo = {};
    let coolCost = 0;
    const albedoCost = LULC_PROPERTIES.cool_roof.cost; // $15
    for (let c of eligibleCells) {
      if (coolCost + albedoCost <= totalBudget) {
        coolChromo[c.id] = 'cool_roof';
        coolCost += albedoCost;
      }
    }

    // 3. Integrated Policy (Optimal Mix: places trees in highest-vulnerability zones, cool roofs in dense urban)
    const mixedChromo = {};
    let mixedCost = 0;
    for (let c of eligibleCells) {
      // Slum/Residential gets trees for shading, dense commercial gets cool roofs
      const targetType = c.originalType === 'dense_urban' ? 'cool_roof' : 'urban_park';
      const cost = LULC_PROPERTIES[targetType].cost;

      if (mixedCost + cost <= totalBudget) {
        mixedChromo[c.id] = targetType;
        mixedCost += cost;
      } else if (mixedCost + 15 <= totalBudget) {
        // Fallback to cheap cool roof coating
        mixedChromo[c.id] = 'cool_roof';
        mixedCost += 15;
      }
    }

    // Evaluate stats for each policy profile
    const getStats = (chromo) => {
      let totalLST = 0;
      let totalHVI = 0;
      let popProtected = 0;

      this.grid.cells.forEach(cell => {
        const type = chromo[cell.id] || cell.type;
        const cached = this.cache[cell.id][type];
        totalLST += cached.lst;

        const hazard = Math.max(0, cached.lst - 30.0);
        totalHVI += hazard * cell.vulnerability * (cell.population / 1000.0);

        // Count as "protected" if the cell temperature drops by > 1.5°C
        const baseLST = this.cache[cell.id][cell.originalType].lst;
        if (baseLST - cached.lst > 1.5) {
          popProtected += cell.population;
        }
      });

      const avgLST = totalLST / 1024;
      return {
        avgLST,
        totalHVI,
        popProtected
      };
    };

    const baseStats = getStats({});
    const greenStats = getStats(greenChromo);
    const coolStats = getStats(coolChromo);
    const mixedStats = getStats(mixedChromo);

    return [
      {
        name: 'Aether-Green Forest Plan',
        cost: greenCost,
        cooling: baseStats.avgLST - greenStats.avgLST,
        popProtected: greenStats.popProtected,
        co2: Object.keys(greenChromo).length * 0.15, // 0.15 Tons per tree cell
        co2Class: 'High',
        roi: (baseStats.avgLST - greenStats.avgLST) / (greenCost / 10000 || 1)
      },
      {
        name: 'Cool Roof Initiative',
        cost: coolCost,
        cooling: baseStats.avgLST - coolStats.avgLST,
        popProtected: coolStats.popProtected,
        co2: 0, // albedo has no direct CO2 sink
        co2Class: 'Low',
        roi: (baseStats.avgLST - coolStats.avgLST) / (coolCost / 10000 || 1)
      },
      {
        name: 'Integrated Resilient Plan',
        cost: mixedCost,
        cooling: baseStats.avgLST - mixedStats.avgLST,
        popProtected: mixedStats.popProtected,
        co2: Object.values(mixedChromo).filter(t => t === 'urban_park').length * 0.15,
        co2Class: 'Medium',
        roi: (baseStats.avgLST - mixedStats.avgLST) / (mixedCost / 10000 || 1)
      }
    ];
  }
}

window.UrbanOptimizer = UrbanOptimizer;
console.log('optimizer.js (SDSS v3.0) loaded successfully');
